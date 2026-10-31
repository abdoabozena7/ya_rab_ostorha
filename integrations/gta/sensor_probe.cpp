// Owned single-player qualification only. No ground-truth policy/perception claim.
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <cstdio>
#include <cmath>
#include <cstring>
#include <string>
#include <type_traits>
#include "sensor_shared.hpp"
#include "native_hashes.hpp"
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
static std::wstring output_path;
static void trace(const Snapshot& s){
    FILE* f=nullptr;_wfopen_s(&f,(output_path+L"\\bridge.jsonl").c_str(),L"ab");if(!f)return;
    fprintf(f,"{\"run_id\":\"%s\",\"pid\":%u,\"frame\":%u,\"game_ms\":%u,\"host_ms\":%llu,\"stage\":\"%s\",\"phase_s\":%.3f,"
      "\"position\":[%.5f,%.5f,%.5f],\"velocity\":[%.5f,%.5f,%.5f],\"camera\":[%.5f,%.5f,%.5f],\"heading_deg\":%.5f,\"speed_mps\":%.5f,\"body_health\":%.3f,"
      "\"sequence\":%llu,\"steering\":%.4f,\"throttle\":%.4f,\"brake\":%.4f,\"lease_expired\":%d,\"sensor_stale\":%d,\"capture_ms\":%llu,"
      "\"rejected_replay\":%u,\"rejected_stale\":%u,\"rejected_owner\":%u,\"ray_status\":%d,\"ray_hit\":%d,\"ray_entity\":%d,\"target\":%d,\"hidden_target\":%d,"
      "\"ray_distance_m\":%.5f,\"project_xy\":[%.6f,%.6f],\"contact\":%d,\"ped_alive\":%d,\"target_contact\":%d,\"fov\":%.3f,\"near\":%.5f,\"far\":%.3f,\"requested_far\":150}\n",
      s.run,s.pid,s.frame,s.game_ms,s.host_ms,s.stage,s.phase_s,s.position.x,s.position.y,s.position.z,s.velocity.x,s.velocity.y,s.velocity.z,
      s.camera.x,s.camera.y,s.camera.z,s.heading,s.speed,s.body_health,s.sequence,s.steer,s.throttle,s.brake,s.lease_expired,s.sensor_stale,s.capture_ms,
      s.rejected_replay,s.rejected_stale,s.rejected_owner,s.ray_status,s.ray_hit,s.ray_entity,s.target,s.hidden_target,s.ray_distance,s.project_x,s.project_y,s.contact,s.ped_alive,s.target_contact,s.fov,s.near_clip,s.far_clip);
    fclose(f);
}
static uint32_t model(const char* name){
    auto h=call<uint32_t>(N::GET_HASH_KEY,name);call(N::REQUEST_MODEL,h);uint64_t until=GetTickCount64()+20000;
    while(!call<int>(N::HAS_MODEL_LOADED,h)&&GetTickCount64()<until)scriptWait(50);
    return call<int>(N::HAS_MODEL_LOADED,h)?h:0;
}
static void place(int entity,Vec p,float heading){call(N::SET_ENTITY_COORDS_NO_OFFSET,entity,p.x,p.y,p.z,true,true,true);call(N::SET_ENTITY_HEADING,entity,heading);}
static void diagnostic(){
    wchar_t path[2048]={};char nonce[33]={},run[33]={},port_text[16]={};
    if(!GetEnvironmentVariableW(L"OSTORHA_SENSOR_OUTPUT",path,2048)||!GetEnvironmentVariableA("OSTORHA_SENSOR_OWNER",nonce,33)||
       !GetEnvironmentVariableA("OSTORHA_BOOTSTRAP_ID",run,33)||!GetEnvironmentVariableA("OSTORHA_SENSOR_PORT",port_text,16))return;
    output_path=path;Snapshot s;s.pid=GetCurrentProcessId();strcpy_s(s.run,run);strcpy_s(s.stage,"INITIALIZING");trace(s);
    WSADATA ws{};if(WSAStartup(MAKEWORD(2,2),&ws))return;
    SOCKET sock=socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP);sockaddr_in local{};local.sin_family=AF_INET;local.sin_addr.s_addr=htonl(INADDR_LOOPBACK);local.sin_port=htons((u_short)atoi(port_text));
    if(bind(sock,(sockaddr*)&local,sizeof(local))==SOCKET_ERROR){closesocket(sock);return;}u_long nonblocking=1;ioctlsocket(sock,FIONBIO,&nonblocking);
    int ped=call<int>(N::PLAYER_PED_ID);while(!ped){scriptWait(100);ped=call<int>(N::PLAYER_PED_ID);}
    int player=call<int>(N::PLAYER_ID);
    // Qualification has no wanted pursuit. Vehicle collision/damage stay active.
    call(N::SET_MAX_WANTED_LEVEL,0);call(N::SET_POLICE_IGNORE_PLAYER,player,true);call(N::SET_DISPATCH_COPS_FOR_PLAYER,player,false);
    call(N::SET_PLAYER_WANTED_LEVEL,player,0,false);call(N::SET_PLAYER_WANTED_LEVEL_NOW,player,false);
    call(N::SET_GAME_PAUSED,false);call(N::SET_PAUSE_MENU_ACTIVE,false);call(N::SET_CLOCK_TIME,12,0,0);call(N::SET_WEATHER_TYPE_NOW_PERSIST,"CLEAR");
    Vec spawn;spawn.x=-1336;spawn.y=-3044;spawn.z=14.5f;
    call(N::REQUEST_COLLISION_AT_COORD,spawn.x,spawn.y,spawn.z);place(ped,spawn,330);
    for(int i=0;i<30;++i){call(N::REQUEST_COLLISION_AT_COORD,spawn.x,spawn.y,spawn.z);scriptWait(100);}
    auto car_model=model("blista"),bus_model=model("bus");if(!car_model||!bus_model){strcpy_s(s.stage,"MODEL_FAILED");trace(s);return;}
    int ego=call<int>(N::CREATE_VEHICLE,car_model,spawn.x,spawn.y,spawn.z,330.f,false,false,false);
    int target=call<int>(N::CREATE_VEHICLE,bus_model,spawn.x+30,spawn.y,spawn.z,330.f,false,false,false);
    int hidden=call<int>(N::CREATE_VEHICLE,bus_model,spawn.x+60,spawn.y,spawn.z,330.f,false,false,false);
    if(!ego||!target||!hidden){strcpy_s(s.stage,"SPAWN_FAILED");trace(s);return;}
    call(N::SET_VEHICLE_ON_GROUND_PROPERLY,ego,5.f);call(N::SET_VEHICLE_ON_GROUND_PROPERLY,target,5.f);call(N::SET_VEHICLE_ON_GROUND_PROPERLY,hidden,5.f);
    scriptWait(1000);call(N::FREEZE_ENTITY_POSITION,target,true);call(N::FREEZE_ENTITY_POSITION,hidden,true);
    Vec bus_position=vector_call(N::GET_ENTITY_COORDS,target,true),min_dim,max_dim;call(N::GET_MODEL_DIMENSIONS,bus_model,&min_dim,&max_dim);
    float rear_length=-min_dim.y;
    call(N::SET_PED_INTO_VEHICLE,ped,ego,-1);call(N::SET_VEHICLE_ENGINE_ON,ego,true,true,false);
    Vec origin=vector_call(N::GET_ENTITY_COORDS,ego,true);
    int camera=call<int>(N::CREATE_CAM,"DEFAULT_SCRIPTED_CAMERA",true);
    call(N::SET_CAM_FOV,camera,s.fov);call(N::SET_CAM_NEAR_CLIP,camera,s.near_clip);call(N::SET_CAM_FAR_CLIP,camera,s.far_clip);
    call(N::RENDER_SCRIPT_CAMS,true,false,0,true,false,0);
    struct Phase {const char* name;int seconds;float range;};
    const Phase phases[]={{"WAIT_RENDER",4,10},{"RANGE10",4,10},{"RANGE30",4,30},{"RANGE60",4,60},{"RANGE100",4,100},
      {"RANGE80",4,80},{"RANGE120",4,120},{"OCCLUSION",4,30},
      {"THROTTLE",4,0},{"BRAKE",4,0},{"LEFT",4,0},{"BRAKE2",4,0},{"RIGHT",4,0},{"DISCONNECT",4,0},{"STALE_SENSORS",4,0},
      {"FOREIGN_OWNER",2,0},{"REPLAY",3,0},{"DELAYED",3,0},{"COLLISION",8,12},{"DONE",2,0}};
    uint64_t phase_started=GetTickCount64(),last_trace=0;int phase=0,previous=-1;
    Command latest{};uint64_t accepted_sequence=0;uint16_t owner_port=0;uint32_t replay=0,stale=0,wrong_owner=0;
    for(;;){
        uint64_t now=GetTickCount64();if(now-phase_started>uint64_t(phases[phase].seconds)*1000){++phase;phase_started=now;if(phase>=int(sizeof(phases)/sizeof(phases[0])))break;}
        auto active=phases[phase];strcpy_s(s.stage,active.name);s.phase_s=float(now-phase_started)/1000;
        call(N::SET_GAME_PAUSED,false);call(N::SET_PAUSE_MENU_ACTIVE,false);
        call(N::SET_MAX_WANTED_LEVEL,0);call(N::SET_POLICE_IGNORE_PLAYER,player,true);
        s.ped_alive=!call<int>(N::IS_ENTITY_DEAD,ped,false);
        if(!s.ped_alive){strcpy_s(s.stage,"DRIVER_DIED");trace(s);break;}
        if(previous!=phase&&(!strcmp(active.name,"LEFT")||!strcmp(active.name,"RIGHT")||!strcmp(active.name,"COLLISION"))){
            // Declared scenario setup only, before the measured stage settles.
            call(N::SET_VEHICLE_HANDBRAKE,ego,true);place(ego,origin,330.f);call(N::SET_ENTITY_VELOCITY,ego,0.f,0.f,0.f);
            call(N::SET_VEHICLE_FIXED,ego);call(N::SET_VEHICLE_ENGINE_ON,ego,true,true,false);
        }
        call(N::GET_ENTITY_MATRIX,ego,&s.forward,&s.right,&s.up,&s.position);
        s.velocity=vector_call(N::GET_ENTITY_VELOCITY,ego);s.speed=call<float>(N::GET_ENTITY_SPEED,ego);
        s.heading=call<float>(N::GET_ENTITY_HEADING,ego);s.body_health=call<float>(N::GET_VEHICLE_BODY_HEALTH,ego);
        s.camera=s.position;s.camera.x+=s.forward.x*1.5f+s.up.x*1.25f;s.camera.y+=s.forward.y*1.5f+s.up.y*1.25f;s.camera.z+=s.forward.z*1.5f+s.up.z*1.25f;
        Vec rotation=vector_call(N::GET_ENTITY_ROTATION,ego,2);call(N::SET_CAM_COORD,camera,s.camera.x,s.camera.y,s.camera.z);call(N::SET_CAM_ROT,camera,rotation.x,rotation.y,rotation.z,2);
        s.fov=call<float>(N::GET_FINAL_RENDERED_CAM_FOV);s.near_clip=call<float>(N::GET_FINAL_RENDERED_CAM_NEAR_CLIP);s.far_clip=call<float>(N::GET_FINAL_RENDERED_CAM_FAR_CLIP);
        if(previous!=phase){
            if(active.range>0){
                Vec p=s.camera;p.x+=s.forward.x*(active.range+rear_length);p.y+=s.forward.y*(active.range+rear_length);p.z=bus_position.z;
                place(target,p,s.heading);p.x+=s.forward.x*15;p.y+=s.forward.y*15;place(hidden,p,s.heading);
                call(N::FREEZE_ENTITY_POSITION,target,true);call(N::FREEZE_ENTITY_POSITION,hidden,true);
            }else{Vec away=spawn;away.x+=200;place(target,away,330);away.x+=30;place(hidden,away,330);}
            previous=phase;
        }
        for(int j=0;j<64;++j){Command incoming{};sockaddr_in sender{};int size=sizeof(sender);
            int bytes=recvfrom(sock,(char*)&incoming,sizeof(incoming),0,(sockaddr*)&sender,&size);if(bytes==SOCKET_ERROR)break;
            if(bytes!=sizeof(incoming)||incoming.magic!=0x4f475431||incoming.version!=1||incoming.type!=1||sender.sin_addr.s_addr!=htonl(INADDR_LOOPBACK)||
               memcmp(incoming.owner,nonce,33)||(owner_port&&owner_port!=sender.sin_port)){++wrong_owner;continue;}
            if(incoming.deadline_ms<now||incoming.deadline_ms>now+500){++stale;continue;}
            if(incoming.sequence<=accepted_sequence){++replay;continue;}
            if(!std::isfinite(incoming.steer)||!std::isfinite(incoming.throttle)||!std::isfinite(incoming.brake)||fabs(incoming.steer)>1||incoming.throttle<0||incoming.throttle>1||incoming.brake<0||incoming.brake>1){++wrong_owner;continue;}
            latest=incoming;accepted_sequence=incoming.sequence;owner_port=sender.sin_port;
        }
        s.host_ms=now;s.frame=call<uint32_t>(N::GET_FRAME_COUNT);s.game_ms=call<uint32_t>(N::GET_GAME_TIMER);s.sequence=accepted_sequence;
        s.capture_ms=InterlockedCompareExchange64(&captured_at,0,0);s.lease_expired=now>latest.deadline_ms;s.sensor_stale=!s.capture_ms||now-s.capture_ms>500;
        s.steer=latest.steer;s.throttle=latest.throttle;s.brake=latest.brake;
        if(s.lease_expired||s.sensor_stale||!strcmp(s.stage,"DONE")){s.steer=0;s.throttle=0;s.brake=1;}
        call(N::SET_VEHICLE_HANDBRAKE,ego,s.brake>=.99f);call(N::SET_CONTROL_VALUE_NEXT_FRAME,0,59,s.steer);
        call(N::SET_CONTROL_VALUE_NEXT_FRAME,0,71,s.throttle);call(N::SET_CONTROL_VALUE_NEXT_FRAME,0,72,s.brake);
        s.rejected_replay=replay;s.rejected_stale=stale;s.rejected_owner=wrong_owner;
        s.contact=call<int>(N::HAS_ENTITY_COLLIDED_WITH_ANYTHING,ego);s.target_contact=call<int>(N::IS_ENTITY_TOUCHING_ENTITY,ego,target);s.target=target;s.hidden_target=hidden;
        if(now-last_trace>=100){
            int ray=call<int>(N::START_EXPENSIVE_SYNCHRONOUS_SHAPE_TEST_LOS_PROBE,s.camera.x,s.camera.y,s.camera.z,
              s.camera.x+s.forward.x*150,s.camera.y+s.forward.y*150,s.camera.z+s.forward.z*150,511,ego,7);
            Vec hit,normal;int did_hit=0,entity=0;s.ray_status=call<int>(N::GET_SHAPE_TEST_RESULT,ray,&did_hit,&hit,&normal,&entity);
            s.ray_hit=did_hit;s.ray_entity=entity;s.ray_distance=did_hit?sqrtf(powf(hit.x-s.camera.x,2)+powf(hit.y-s.camera.y,2)+powf(hit.z-s.camera.z,2)):-1.f;
            s.project_x=-1;s.project_y=-1;if(did_hit)call(N::GET_SCREEN_COORD_FROM_WORLD_COORD,hit.x,hit.y,hit.z,&s.project_x,&s.project_y);
            trace(s);last_trace=now;
        }
        AcquireSRWLockExclusive(&state_lock);state=s;ReleaseSRWLockExclusive(&state_lock);scriptWait(0);
    }
    call(N::SET_VEHICLE_HANDBRAKE,ego,true);closesocket(sock);WSACleanup();
}
BOOL APIENTRY DllMain(HMODULE module,DWORD reason,LPVOID){
    if(reason==DLL_PROCESS_ATTACH){DisableThreadLibraryCalls(module);scriptRegister(module,diagnostic);}
    else if(reason==DLL_PROCESS_DETACH)scriptUnregister(module);return TRUE;
}
