// Live low-speed inspection; scenario truth is evaluation-only, never driving input.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <windows.h>
#include <cstdio>
#include <cmath>
#include <cstring>
#include <string>
#include <type_traits>
#include "sensor_shared.hpp"
#include "native_hashes.hpp"
#include "urban_settings.hpp"
#include <vector>
#include <random>
#include <algorithm>
#pragma comment(lib,"Ws2_32.lib")
__declspec(dllimport) void scriptRegister(HMODULE,void(*)());
__declspec(dllimport) void scriptUnregister(HMODULE);
__declspec(dllimport) void scriptWait(DWORD);
__declspec(dllimport) void nativeInit(unsigned long long);
__declspec(dllimport) void nativePush64(unsigned long long);
__declspec(dllimport) unsigned long long* nativeCall();
template<class A>void push(A value){static_assert(sizeof(A)<=8);uint64_t bits=0;memcpy(&bits,&value,sizeof(A));nativePush64(bits);}
template<class R=void,class...A>R call(uint64_t hash,A...args){
    nativeInit(hash);(push(args),...);auto result=nativeCall();
    if constexpr(!std::is_void_v<R>){R out{};memcpy(&out,result,sizeof(R));return out;}
}
template<class...A>Vec vector_call(uint64_t hash,A...args){
    nativeInit(hash);(push(args),...);auto result=nativeCall();Vec out;
    memcpy(&out.x,result,4);memcpy(&out.y,result+1,4);memcpy(&out.z,result+2,4);return out;
}
static SRWLOCK state_lock=SRWLOCK_INIT;
static Snapshot state;
static volatile LONG64 captured_at=0;
extern "C" __declspec(dllexport) bool OstorhaGetSnapshot(Snapshot* out){
    if(!out)return false;AcquireSRWLockShared(&state_lock);*out=state;ReleaseSRWLockShared(&state_lock);return state.pid!=0;
}
extern "C" __declspec(dllexport) void OstorhaPublishCapture(uint64_t tick){InterlockedExchange64(&captured_at,tick);}
static std::wstring output_path; static int wanted_level=0;
static void trace(const Snapshot& s){
    FILE* f=nullptr;_wfopen_s(&f,(output_path+L"\\bridge.jsonl").c_str(),L"ab");if(!f)return;
    fprintf(f,"{\"run_id\":\"%s\",\"pid\":%u,\"frame\":%u,\"game_ms\":%u,\"host_ms\":%llu,\"stage\":\"%s\",\"phase_s\":%.3f,"
      "\"position\":[%.5f,%.5f,%.5f],\"velocity\":[%.5f,%.5f,%.5f],\"camera\":[%.5f,%.5f,%.5f],\"heading_deg\":%.5f,\"speed_mps\":%.5f,\"body_health\":%.3f,"
      "\"sequence\":%llu,\"steering\":%.4f,\"throttle\":%.4f,\"brake\":%.4f,\"lease_expired\":%d,\"sensor_stale\":%d,\"capture_ms\":%llu,"
      "\"rejected_replay\":%u,\"rejected_stale\":%u,\"rejected_owner\":%u,\"ray_status\":%d,\"ray_hit\":%d,\"ray_entity\":%d,\"target\":%d,\"hidden_target\":%d,"
      "\"ray_distance_m\":%.5f,\"project_xy\":[%.6f,%.6f],\"contact\":%d,\"ped_alive\":%d,\"target_contact\":%d,\"fov\":%.3f,\"near\":%.5f,\"far\":%.3f,\"forward\":[%.6f,%.6f,%.6f],\"right\":[%.6f,%.6f,%.6f],\"up\":[%.6f,%.6f,%.6f],\"wanted_level\":%d}\n",
      s.run,s.pid,s.frame,s.game_ms,s.host_ms,s.stage,s.phase_s,s.position.x,s.position.y,s.position.z,s.velocity.x,s.velocity.y,s.velocity.z,
      s.camera.x,s.camera.y,s.camera.z,s.heading,s.speed,s.body_health,s.sequence,s.steer,s.throttle,s.brake,s.lease_expired,s.sensor_stale,s.capture_ms,
      s.rejected_replay,s.rejected_stale,s.rejected_owner,s.ray_status,s.ray_hit,s.ray_entity,s.target,s.hidden_target,s.ray_distance,s.project_x,s.project_y,s.contact,s.ped_alive,s.target_contact,s.fov,s.near_clip,s.far_clip,s.forward.x,s.forward.y,s.forward.z,s.right.x,s.right.y,s.right.z,s.up.x,s.up.y,s.up.z,wanted_level);
    fclose(f);
}
static uint32_t model(const char* name){
    auto h=call<uint32_t>(N::GET_HASH_KEY,name);call(N::REQUEST_MODEL,h);uint64_t until=GetTickCount64()+20000;
    while(!call<int>(N::HAS_MODEL_LOADED,h)&&GetTickCount64()<until)scriptWait(50);
    return call<int>(N::HAS_MODEL_LOADED,h)?h:0;
}
static void place(int entity,Vec p,float heading){call(N::SET_ENTITY_COORDS_NO_OFFSET,entity,p.x,p.y,p.z,true,true,true);call(N::SET_ENTITY_HEADING,entity,heading);}

static float distance(Vec a,Vec b){return sqrtf(powf(a.x-b.x,2)+powf(a.y-b.y,2)+powf(a.z-b.z,2));}
static Vec forward(float h){Vec v;float a=h*3.14159265359f/180;v.x=-sinf(a);v.y=cosf(a);return v;}
static Vec right(float h){Vec v;float a=h*3.14159265359f/180;v.x=cosf(a);v.y=sinf(a);return v;}
static void scan(const Snapshot& s,int ego){
    FILE* f=nullptr;_wfopen_s(&f,(output_path+L"/geometry.jsonl").c_str(),L"ab");if(!f)return;
    uint64_t started=GetTickCount64();fprintf(f,"{\"run_id\":\"%s\",\"pid\":%u,\"frame\":%u,\"host_ms\":%llu,\"rays\":[",s.run,s.pid,s.frame,started);
    const float elevations[]={-6.f,-2.f,-.5f,0.f,2.f,6.f};int count=0;
    for(float elevation:elevations)for(int azimuth=0;azimuth<360;azimuth+=2){
        float a=azimuth*3.14159265359f/180,e=elevation*3.14159265359f/180;Vec d;
        d.x=(s.forward.x*cosf(a)+s.right.x*sinf(a))*cosf(e)+s.up.x*sinf(e);
        d.y=(s.forward.y*cosf(a)+s.right.y*sinf(a))*cosf(e)+s.up.y*sinf(e);
        d.z=(s.forward.z*cosf(a)+s.right.z*sinf(a))*cosf(e)+s.up.z*sinf(e);
        int q=call<int>(N::START_EXPENSIVE_SYNCHRONOUS_SHAPE_TEST_LOS_PROBE,s.camera.x,s.camera.y,s.camera.z,
            s.camera.x+d.x*100,s.camera.y+d.y*100,s.camera.z+d.z*100,511,ego,7);
        Vec point,norm;int hit=0,entity=0,status=call<int>(N::GET_SHAPE_TEST_RESULT,q,&hit,&point,&norm,&entity);
        float dist=hit?distance(point,s.camera):(status==2?100.f:-1.f);
        fprintf(f,"%s[%d,%.2f,%d,%d,%.5f,%.5f,%.5f,%.5f,%d]",count++?",":"",azimuth,elevation,status,hit,dist,point.x,point.y,point.z,entity);
    }
    fprintf(f,"],\"scan_ms\":%llu,\"actor_handles_evaluation_only\":true}",GetTickCount64()-started);fputc(10,f);fclose(f);
}
static void diagnostic(){
    wchar_t path[2048]={};char nonce[33]={},run[33]={},port_text[16]={};
    if(!GetEnvironmentVariableW(L"OSTORHA_SENSOR_OUTPUT",path,2048)||!GetEnvironmentVariableA("OSTORHA_SENSOR_OWNER",nonce,33)||
       !GetEnvironmentVariableA("OSTORHA_BOOTSTRAP_ID",run,33)||!GetEnvironmentVariableA("OSTORHA_SENSOR_PORT",port_text,16))return;
    output_path=path;Snapshot s;s.pid=GetCurrentProcessId();strcpy_s(s.run,run);strcpy_s(s.stage,"INITIALIZING");trace(s);
    WSADATA ws{};if(WSAStartup(MAKEWORD(2,2),&ws))return;
    SOCKET sock=socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP);sockaddr_in local{};
    local.sin_family=AF_INET;local.sin_addr.s_addr=htonl(INADDR_LOOPBACK);local.sin_port=htons((u_short)atoi(port_text));
    if(bind(sock,(sockaddr*)&local,sizeof(local))==SOCKET_ERROR){closesocket(sock);return;}
    u_long nonblocking=1;ioctlsocket(sock,FIONBIO,&nonblocking);
    int ped=call<int>(N::PLAYER_PED_ID);while(!ped){scriptWait(100);ped=call<int>(N::PLAYER_PED_ID);}
    int player=call<int>(N::PLAYER_ID);
    call(N::SET_MAX_WANTED_LEVEL,0);call(N::SET_PLAYER_WANTED_LEVEL,player,0,false);call(N::SET_PLAYER_WANTED_LEVEL_NOW,player,false);
    call(N::SET_POLICE_IGNORE_PLAYER,player,true);call(N::SET_DISPATCH_COPS_FOR_PLAYER,player,false);
    call(N::SET_CLOCK_TIME,12,0,0);call(N::SET_WEATHER_TYPE_NOW_PERSIST,"CLEAR");
    Vec origin;origin.x=-1336.f;origin.y=-3044.f;origin.z=14.5f;
    place(ped,origin,330.f);for(int i=0;i<30;++i){call(N::REQUEST_COLLISION_AT_COORD,origin.x,origin.y,origin.z);scriptWait(100);}
    auto hash=model("blista");if(!hash){strcpy_s(s.stage,"MODEL_FAILED");trace(s);return;}
    int ego=call<int>(N::CREATE_VEHICLE,hash,origin.x,origin.y,origin.z,330.f,false,false,false);
    if(!ego){strcpy_s(s.stage,"SPAWN_FAILED");trace(s);return;}
    call(N::SET_ENTITY_AS_MISSION_ENTITY,ego,true,true);call(N::SET_VEHICLE_ON_GROUND_PROPERLY,ego,5.f);
    call(N::SET_PED_INTO_VEHICLE,ped,ego,-1);call(N::SET_VEHICLE_ENGINE_ON,ego,true,true,false);call(N::SET_VEHICLE_HANDBRAKE,ego,true);
    uint64_t ready_at=GetTickCount64();int camera=call<int>(N::CREATE_CAM,"DEFAULT_SCRIPTED_CAMERA",true);float camera_yaw=0;
    call(N::SET_CAM_FOV,camera,60.f);call(N::SET_CAM_NEAR_CLIP,camera,.15f);call(N::SET_CAM_FAR_CLIP,camera,150.f);
    call(N::RENDER_SCRIPT_CAMS,true,false,0,true,false,0);
    Command latest{};uint64_t sequence=0,last_trace=0,last_population=0;uint16_t owner_port=0;
    uint32_t replay=0,stale=0,wrong_owner=0;bool settings_opened=false;
    for(;;){
        uint64_t now=GetTickCount64();s.phase_s=float(now-ready_at)/1000;
        strcpy_s(s.stage,now-ready_at>U::DURATION_MS?"DONE":"FOUNDATION_CALIBRATION");
        if(GetFileAttributesW((output_path+L"/settings-mode").c_str())!=INVALID_FILE_ATTRIBUTES){
            call(N::SET_VEHICLE_HANDBRAKE,ego,true);
            if(!settings_opened&&now-ready_at>=6000){call(N::RENDER_SCRIPT_CAMS,false,false,0,true,false,0);call(N::ACTIVATE_FRONTEND_MENU,call<uint32_t>(N::GET_HASH_KEY,"FE_MENU_VERSION_SP_PAUSE"),true,-1);settings_opened=true;}
            scriptWait(0);continue;
        }
        call(N::SET_GAME_PAUSED,false);call(N::SET_PAUSE_MENU_ACTIVE,false);
        call(N::SET_PED_DENSITY_MULTIPLIER_THIS_FRAME,0.f);call(N::SET_VEHICLE_DENSITY_MULTIPLIER_THIS_FRAME,0.f);
        call(N::SET_MAX_WANTED_LEVEL,0);call(N::SET_PLAYER_WANTED_LEVEL,player,0,false);call(N::SET_PLAYER_WANTED_LEVEL_NOW,player,false);
        call(N::SET_POLICE_IGNORE_PLAYER,player,true);wanted_level=call<int>(N::GET_PLAYER_WANTED_LEVEL,player);
        s.ped_alive=call<int>(N::DOES_ENTITY_EXIST,ped)&&!call<int>(N::IS_ENTITY_DEAD,ped,false);if(!s.ped_alive){strcpy_s(s.stage,"DRIVER_DIED");trace(s);break;}
        call(N::GET_ENTITY_MATRIX,ego,&s.forward,&s.right,&s.up,&s.position);
        s.velocity=vector_call(N::GET_ENTITY_VELOCITY,ego);s.speed=call<float>(N::GET_ENTITY_SPEED,ego);
        s.heading=call<float>(N::GET_ENTITY_HEADING,ego);s.body_health=call<float>(N::GET_VEHICLE_BODY_HEALTH,ego);
        s.camera=s.position;s.camera.x+=s.forward.x*1.5f+s.up.x*1.25f;s.camera.y+=s.forward.y*1.5f+s.up.y*1.25f;s.camera.z+=s.forward.z*1.5f+s.up.z*1.25f;
        Vec rotation=vector_call(N::GET_ENTITY_ROTATION,ego,2);call(N::SET_CAM_COORD,camera,s.camera.x,s.camera.y,s.camera.z);call(N::SET_CAM_ROT,camera,rotation.x,rotation.y,rotation.z+camera_yaw,2);
        s.fov=call<float>(N::GET_FINAL_RENDERED_CAM_FOV);s.near_clip=call<float>(N::GET_FINAL_RENDERED_CAM_NEAR_CLIP);s.far_clip=call<float>(N::GET_FINAL_RENDERED_CAM_FAR_CLIP);
        for(int j=0;j<64;++j){
            Command in{};sockaddr_in sender{};int size=sizeof(sender);int bytes=recvfrom(sock,(char*)&in,sizeof(in),0,(sockaddr*)&sender,&size);if(bytes==SOCKET_ERROR)break;
            if(bytes!=sizeof(in)||in.magic!=0x4f475431||in.version!=1||(in.type!=1&&in.type!=2&&(in.type<10||in.type>13))||sender.sin_addr.s_addr!=htonl(INADDR_LOOPBACK)||
               memcmp(in.owner,nonce,33)||(owner_port&&owner_port!=sender.sin_port)){++wrong_owner;continue;}
            if(in.deadline_ms<now||in.deadline_ms>now+300){++stale;continue;}
            if(in.sequence<=sequence){++replay;continue;}
            if(!std::isfinite(in.steer)||!std::isfinite(in.throttle)||!std::isfinite(in.brake)||fabs(in.steer)>1||in.throttle<0||in.throttle>1||in.brake<0||in.brake>1){++wrong_owner;continue;}
            if(in.type>=10){camera_yaw=in.type==11?90.f:in.type==12?-90.f:in.type==13?180.f:0.f;in.steer=0;in.throttle=0;in.brake=1;}
            latest=in;sequence=in.sequence;owner_port=sender.sin_port;
        }
        s.host_ms=now;s.frame=call<uint32_t>(N::GET_FRAME_COUNT);s.game_ms=call<uint32_t>(N::GET_GAME_TIMER);s.sequence=sequence;
        s.capture_ms=InterlockedCompareExchange64(&captured_at,0,0);s.lease_expired=now>latest.deadline_ms;s.sensor_stale=!s.capture_ms||now-s.capture_ms>350;
        s.steer=latest.steer;s.throttle=latest.throttle;s.brake=latest.brake;
        if(s.speed>2.5f){s.throttle=0;s.brake=std::max(s.brake,.35f);}
        if(s.lease_expired||s.sensor_stale||!strcmp(s.stage,"DONE")){s.steer=0;s.throttle=0;s.brake=1;}
        for(int control:{60,63,64,73,75,76})call(N::DISABLE_CONTROL_ACTION,0,control,true);
        for(int control:{59,71,72})call(N::ENABLE_CONTROL_ACTION,0,control,true);
        call(N::SET_VEHICLE_HANDBRAKE,ego,s.brake>=.99f);call(N::SET_CONTROL_VALUE_NEXT_FRAME,0,59,s.steer);
        bool reverse=latest.type==2;
        call(N::SET_CONTROL_VALUE_NEXT_FRAME,0,71,reverse?0.f:s.throttle);call(N::SET_CONTROL_VALUE_NEXT_FRAME,0,72,s.brake>=.99f?0.f:reverse?s.throttle:s.brake);
        s.rejected_replay=replay;s.rejected_stale=stale;s.rejected_owner=wrong_owner;s.contact=call<int>(N::HAS_ENTITY_COLLIDED_WITH_ANYTHING,ego);
        if(now-last_trace>=100){trace(s);scan(s,ego);last_trace=GetTickCount64();}
        if(now-last_population>=100){
            FILE* view=nullptr;_wfopen_s(&view,(output_path+L"/camera-views.jsonl").c_str(),L"ab");
            if(view){fprintf(view,"{\"host_ms\":%llu,\"frame\":%u,\"yaw_offset_deg\":%.2f,\"command_type\":%u,\"reverse\":%s,\"longitudinal_speed_mps\":%.6f}\n",now,s.frame,camera_yaw,latest.type,reverse?"true":"false",s.velocity.x*s.forward.x+s.velocity.y*s.forward.y+s.velocity.z*s.forward.z);fclose(view);}last_population=now;
        }
        AcquireSRWLockExclusive(&state_lock);state=s;ReleaseSRWLockExclusive(&state_lock);
        if(!strcmp(s.stage,"DONE")){trace(s);break;}
        scriptWait(0);
    }
    call(N::SET_VEHICLE_HANDBRAKE,ego,true);closesocket(sock);WSACleanup();
}
BOOL APIENTRY DllMain(HMODULE module,DWORD reason,LPVOID){
    if(reason==DLL_PROCESS_ATTACH){DisableThreadLibraryCalls(module);scriptRegister(module,diagnostic);}
    else if(reason==DLL_PROCESS_DETACH)scriptUnregister(module);return TRUE;
}
