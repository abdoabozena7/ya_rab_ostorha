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
#pragma comment(lib,"User32.lib")
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

#pragma pack(push,1)
struct GoalCommand {Command base;uint64_t input_sequence;uint64_t source_frame;};
#pragma pack(pop)
static_assert(sizeof(GoalCommand)==85,"Goal command ABI");
using KeyboardHandler=void(*)(DWORD,WORD,BYTE,BOOL,BOOL,BOOL,BOOL);
__declspec(dllimport) void keyboardHandlerRegister(KeyboardHandler);
__declspec(dllimport) void keyboardHandlerUnregister(KeyboardHandler);
static volatile LONG pending_x=0;
static void on_key(DWORD key,WORD,BYTE,BOOL,BOOL,BOOL was_down,BOOL is_up){
    if(key!='X'||was_down||is_up)return;
    DWORD foreground_pid=0;GetWindowThreadProcessId(GetForegroundWindow(),&foreground_pid);
    if(foreground_pid==GetCurrentProcessId())InterlockedIncrement(&pending_x);
}
static bool human_mode=false,input_focused=false;
static uint64_t input_sequence=0,mode_epoch=0,mode_first_sequence=0;
static uint64_t input_times[32]={};
static float input_steer=0,input_w=0,input_s=0,input_handbrake=0;
static SRWLOCK state_lock=SRWLOCK_INIT;
static Snapshot state;
static volatile LONG64 captured_at=0;
extern "C" __declspec(dllexport) bool OstorhaGetSnapshot(Snapshot* out){
    if(!out)return false;AcquireSRWLockShared(&state_lock);*out=state;ReleaseSRWLockShared(&state_lock);return state.pid!=0;
}
extern "C" __declspec(dllexport) void OstorhaPublishCapture(uint64_t tick){InterlockedExchange64(&captured_at,tick);}
static std::wstring output_path; static int wanted_level=0;

static void read_driving_input(uint64_t now,uint32_t frame,const char* run){
    DWORD foreground_pid=0;GetWindowThreadProcessId(GetForegroundWindow(),&foreground_pid);
    input_focused=foreground_pid==GetCurrentProcessId();
    // Only six explicitly authorized driving keys, only in GTA foreground.
    LONG changes=InterlockedExchange(&pending_x,0);
    if(input_focused&&(changes%2)){human_mode=!human_mode;++mode_epoch;mode_first_sequence=input_sequence+1;}
    input_steer=input_focused?float(bool(GetAsyncKeyState('D')&0x8000))-float(bool(GetAsyncKeyState('A')&0x8000)):0.f;
    input_w=input_focused&&bool(GetAsyncKeyState('W')&0x8000)?1.f:0.f;
    input_s=input_focused&&bool(GetAsyncKeyState('S')&0x8000)?1.f:0.f;
    input_handbrake=input_focused&&bool(GetAsyncKeyState(VK_SPACE)&0x8000)?1.f:0.f;
    ++input_sequence;input_times[input_sequence%32]=now;
    FILE* f=nullptr;_wfopen_s(&f,(output_path+L"/driving-input.jsonl").c_str(),L"ab");
    if(f){fprintf(f,"{\"run_id\":\"%s\",\"pid\":%u,\"frame\":%u,\"host_ms\":%llu,\"sequence\":%llu,\"mode_epoch\":%llu,\"human\":%s,\"focused\":%s,\"steering\":%.4f,\"forward\":%.4f,\"brake_reverse\":%.4f,\"handbrake\":%.4f}\n",run,GetCurrentProcessId(),frame,now,input_sequence,mode_epoch,human_mode?"true":"false",input_focused?"true":"false",input_steer,input_w,input_s,input_handbrake);fclose(f);}
}
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
static bool road_node(Vec desired,Vec& position,float& heading){
    return call<int>(N::GET_CLOSEST_VEHICLE_NODE_WITH_HEADING,desired.x,desired.y,desired.z,&position,&heading,1,3.f,0.f)!=0;
}
static float road_band(Vec p,float h){
    if(!call<int>(N::IS_POINT_ON_ROAD,p.x,p.y,p.z,0))return 0;
    Vec r=right(h);float widths[2]={};
    for(int i=0;i<2;++i)for(float d=.5f;d<=14;d+=.5f){
        float sign=i?-1.f:1.f;
        if(!call<int>(N::IS_POINT_ON_ROAD,p.x+sign*d*r.x,p.y+sign*d*r.y,p.z,0))break;
        widths[i]=d;
    }
    return widths[0]+widths[1]+.5f;
}
static bool grounded(Vec& p){
    float z=0;
    if(!call<int>(N::GET_GROUND_Z_FOR_3D_COORD,p.x,p.y,p.z+20.f,&z,false,false))return false;
    p.z=z;return true;
}
static bool center_road(Vec& p,float h){
    Vec node;float node_h=0;
    if(!road_node(p,node,node_h))return false;
    p.z=node.z;
    if(!call<int>(N::IS_POINT_ON_ROAD,p.x,p.y,p.z,0))return false;
    Vec r=right(h);float widths[2]={};
    for(int i=0;i<2;++i)for(float d=.25f;d<=14;d+=.25f){
        float sign=i?-1.f:1.f;
        if(!call<int>(N::IS_POINT_ON_ROAD,p.x+sign*d*r.x,p.y+sign*d*r.y,p.z,0))break;
        widths[i]=d;
    }
    float shift=(widths[0]-widths[1])*.5f;
    p.x+=r.x*shift;p.y+=r.y*shift;return true;
}
static bool on_road_at_actor(Vec p){
    Vec node;float h=0;
    if(!road_node(p,node,h)||fabsf(p.z-node.z)>2.5f)return false;
    return call<int>(N::IS_POINT_ON_ROAD,p.x,p.y,node.z,0)!=0;
}
static bool clear_ped_space(Vec p,float h){
    for(Vec axis:{forward(h),right(h)}){
        int q=call<int>(N::START_EXPENSIVE_SYNCHRONOUS_SHAPE_TEST_LOS_PROBE,
            p.x-axis.x*.4f,p.y-axis.y*.4f,p.z+.85f,p.x+axis.x*.4f,p.y+axis.y*.4f,p.z+.85f,3,0,7);
        Vec hit,norm;int blocked=0,e=0;
        if(call<int>(N::GET_SHAPE_TEST_RESULT,q,&blocked,&hit,&norm,&e)!=2||blocked)return false;
    }
    return true;
}
static void setup_note(const char* reason,Vec p,float h,float detail){
    FILE* f=nullptr;_wfopen_s(&f,(output_path+L"/setup-diagnostic.jsonl").c_str(),L"ab");if(!f)return;
    fprintf(f,"{\"reason\":\"%s\",\"position\":[%.5f,%.5f,%.5f],\"heading\":%.5f,\"detail\":%.5f}",reason,p.x,p.y,p.z,h,detail);
    fputc(10,f);fclose(f);
}
static bool straight_corridor(Vec p,float h){
    Vec f=forward(h),r=right(h);
    for(float along=4;along<=84;along+=4){
        Vec q=p,node;float node_h=0;q.x+=f.x*along;q.y+=f.y*along;
        if(!road_node(q,node,node_h)){setup_note("CORRIDOR_NO_NODE",q,h,along);return false;}
        q.z=node.z;
        for(float side:{-1.f,0.f,1.f})
            if(!call<int>(N::IS_POINT_ON_ROAD,q.x+r.x*side,q.y+r.y*side,q.z,0)){setup_note("CORRIDOR_OFF_ROAD",q,h,along);return false;}
    }
    return true;
}
struct Actor {
    int entity=0,driver=0;Vec initial;bool moving_before_block=false,bike=false,local_car=false;
    bool crosser=false,cross_active=false,entered=false,casualty_logged=false,bike_return=false;
    Vec cross_start,cross_goal,cross_center,cross_right;
    float cross_width=0,cross_speed=1.2f;uint64_t due_ms=0,started_ms=0;
};
struct Parked {int entity=0;bool left=false;Vec minimum,maximum;};
static std::vector<Actor> cars,walkers;static std::vector<Parked> parked;
static Vec origin,junction;static float origin_heading=0,junction_heading=0,band=0;
static std::string street_name="UNKNOWN",junction_name="UNKNOWN";
static bool blocker_stopped=false;static uint64_t ready_at=0;
static char current_run[33]={};
static float ego_width=0;
static void crossing_event(const Actor& actor,const char* event,Vec p){
    FILE* f=nullptr;_wfopen_s(&f,(output_path+L"/crossings.jsonl").c_str(),L"ab");if(!f)return;
    float side=(actor.cross_start.x-actor.cross_center.x)*actor.cross_right.x+(actor.cross_start.y-actor.cross_center.y)*actor.cross_right.y;
    fprintf(f,"{\"run_id\":\"%s\",\"pid\":%u,\"event\":\"%s\",\"entity\":%d,\"host_ms\":%llu,\"game_ms\":%u,\"direction\":\"%s\","
        "\"position\":[%.5f,%.5f,%.5f],\"start\":[%.5f,%.5f,%.5f],\"goal\":[%.5f,%.5f,%.5f],\"teleport\":false}",
        current_run,GetCurrentProcessId(),event,actor.entity,GetTickCount64(),call<uint32_t>(N::GET_GAME_TIMER),side<0?"LEFT_TO_RIGHT":"RIGHT_TO_LEFT",
        p.x,p.y,p.z,actor.cross_start.x,actor.cross_start.y,actor.cross_start.z,actor.cross_goal.x,actor.cross_goal.y,actor.cross_goal.z);
    fputc(10,f);fclose(f);
}
static bool make_parking(uint32_t* models){
    const float left_slots[]={9,24,39,54,69},right_slots[]={9,24,44,54,79};
    Vec f=forward(origin_heading),r=right(origin_heading);
    for(int i=0;i<10;++i){
        bool left=i<5;float along=left?left_slots[i]:right_slots[i-5];
        // Partial curb parking leaves real, varying clearance in the road.
        float intrusion=.35f+.12f*(i%4),side=(left?-1.f:1.f)*(band*.5f-intrusion);
        Vec p=origin;p.x+=f.x*along+r.x*side;p.y+=f.y*along+r.y*side;
        uint32_t hash=models[i%8];
        int e=call<int>(N::CREATE_VEHICLE,hash,p.x,p.y,p.z+1.f,origin_heading+(left?180.f:0.f),false,false,false);
        if(!e)return false;
        call(N::SET_ENTITY_AS_MISSION_ENTITY,e,true,true);call(N::SET_VEHICLE_ON_GROUND_PROPERLY,e,5.f);
        call(N::SET_VEHICLE_ENGINE_ON,e,false,true,false);call(N::SET_VEHICLE_HANDBRAKE,e,true);
        Parked a;a.entity=e;a.left=left;call(N::GET_MODEL_DIMENSIONS,hash,&a.minimum,&a.maximum);parked.push_back(a);
    }
    return parked.size()==10;
}
static void parking_trace(const Snapshot& s){
    FILE* out=nullptr;_wfopen_s(&out,(output_path+L"/parking.jsonl").c_str(),L"ab");if(!out)return;
    Vec frame_f=forward(origin_heading),frame_r=right(origin_heading);
    fprintf(out,"{\"host_ms\":%llu,\"road_band_m\":%.5f,\"ego_width_m\":%.5f,\"parked\":[",s.host_ms,band,ego_width);
    int count=0;
    for(auto& a:parked){
        Vec f,r,u,p;call(N::GET_ENTITY_MATRIX,a.entity,&f,&r,&u,&p);
        float xmin=1e9f,xmax=-1e9f,ymin=1e9f,ymax=-1e9f;
        for(float x:{a.minimum.x,a.maximum.x})for(float y:{a.minimum.y,a.maximum.y})for(float z:{a.minimum.z,a.maximum.z}){
            Vec q=p;q.x+=r.x*x+f.x*y+u.x*z;q.y+=r.y*x+f.y*y+u.y*z;
            float along=(q.x-origin.x)*frame_f.x+(q.y-origin.y)*frame_f.y;
            float side=(q.x-origin.x)*frame_r.x+(q.y-origin.y)*frame_r.y;
            xmin=std::min(xmin,along);xmax=std::max(xmax,along);ymin=std::min(ymin,side);ymax=std::max(ymax,side);
        }
        fprintf(out,"%s{\"entity\":%d,\"side\":\"%s\",\"exists\":%s,\"along_min_m\":%.5f,\"along_max_m\":%.5f,"
            "\"lateral_min_m\":%.5f,\"lateral_max_m\":%.5f,\"body_health\":%.3f,\"frozen_commanded\":false,\"invincible_commanded\":false}",
            count++?",":"",a.entity,a.left?"LEFT":"RIGHT",call<int>(N::DOES_ENTITY_EXIST,a.entity)?"true":"false",xmin,xmax,ymin,ymax,
            call<float>(N::GET_VEHICLE_BODY_HEALTH,a.entity));
    }
    fprintf(out,"]}");fputc(10,out);fclose(out);
}
static std::string street(Vec p){
    uint32_t main=0,cross=0;call(N::GET_STREET_NAME_AT_COORD,p.x,p.y,p.z,&main,&cross);
    const char* name=call<const char*>(N::GET_STREET_NAME_FROM_HASH_KEY,main);
    return name&&*name?name:"UNKNOWN";
}
static bool choose_site(int ped){
    Vec anchor;anchor.x=U::X;anchor.y=U::Y;anchor.z=U::Z;
    place(ped,anchor,0.f);
    for(int i=0;i<30;++i){call(N::REQUEST_COLLISION_AT_COORD,anchor.x,anchor.y,anchor.z);scriptWait(100);}
    // Retain actual native road membership rather than infer its surface from
    // model/terrain heights. This diagnostic also explains rejected layouts.
    Vec known;known.x=-172.75f;known.y=-1698.f;known.z=31.28125f;
    Vec kf=forward(223.23708f),kr=right(223.23708f);
    FILE* grid=nullptr;_wfopen_s(&grid,(output_path+L"/road-surface.jsonl").c_str(),L"ab");
    for(float along=-20;along<=100;along+=2)for(float side=-10;side<=10;side+=1){
        Vec p=known,node;float h=0;p.x+=kf.x*along+kr.x*side;p.y+=kf.y*along+kr.y*side;
        bool found=road_node(p,node,h);if(found)p.z=node.z;
        int road=found?call<int>(N::IS_POINT_ON_ROAD,p.x,p.y,p.z,0):0;
        if(grid)fprintf(grid,"{\"along\":%.1f,\"side\":%.1f,\"x\":%.5f,\"y\":%.5f,\"nav_z\":%.5f,\"road\":%s}\n",along,side,p.x,p.y,p.z,road?"true":"false");
    }
    if(grid)fclose(grid);
    float best=1e9f;
    for(int x=-60;x<=60;x+=20)for(int y=-60;y<=60;y+=20){
        Vec wanted=anchor,p;wanted.x+=x;wanted.y+=y;float h=0;
        if(!road_node(wanted,p,h)||fabsf(p.z-anchor.z)>10)continue;
        float width=road_band(p,h),cost=distance(anchor,p);
        if(width<6||width>7.5f||cost>=best)continue;
        setup_note("CANDIDATE",p,h,width);
        origin=p;origin_heading=h;band=width;best=cost;
    }
    if(best==1e9f){setup_note("NO_CORRIDOR",anchor,0,0);return false;}
    setup_note("SELECTED",origin,origin_heading,band);
    best=1e9f;
    for(int x=-160;x<=160;x+=20)for(int y=-160;y<=160;y+=20){
        Vec wanted=origin,p;wanted.x+=x;wanted.y+=y;float h=0;
        if(!road_node(wanted,p,h)||fabsf(p.z-origin.z)>10)continue;
        uint32_t name=0,cross=0;call(N::GET_STREET_NAME_AT_COORD,p.x,p.y,p.z,&name,&cross);
        float gap=distance(origin,p),cost=fabsf(gap-95.f);
        Vec f=forward(origin_heading);float alignment=fabsf(((p.x-origin.x)*f.x+(p.y-origin.y)*f.y)/std::max(gap,.01f));
        if(name&&cross&&gap>=65&&gap<=150&&alignment>.85f&&cost<best){junction=p;junction_heading=h;best=cost;}
    }
    if(best==1e9f){setup_note("NO_JUNCTION",origin,origin_heading,0);return false;}
    Vec f=forward(origin_heading);
    if((junction.x-origin.x)*f.x+(junction.y-origin.y)*f.y<0)origin_heading+=180;
    street_name=street(origin);junction_name=street(junction);return true;
}
static bool populate(int ego){
    std::mt19937 random(U::SEED);std::uniform_real_distribution<float> unit(0,1);
    const char* models[]={"asea","blista","ingot","premier","emperor","stanier","minivan","surfer"};
    uint32_t vehicle_models[8]={};for(int i=0;i<8;++i){vehicle_models[i]=model(models[i]);if(!vehicle_models[i])return false;}
    uint32_t male=model("a_m_y_business_01"),female=model("a_f_y_soucent_01");
    if(!male||!female)return false;
    uint32_t bike_models[]={model("faggio"),model("pcj")};
    for(auto hash:bike_models)if(!hash)return false;
    if(!make_parking(vehicle_models))return false;
    for(int attempt=0;cars.size()<U::CARS&&attempt<6000;++attempt){
        if(attempt%25==0)scriptWait(0);
        int i=int(cars.size());Vec wanted=junction,p;float h=0;
        bool local_car=i>=1&&i<=4,bike=i>=5&&i<=6;
        if(i==0){Vec f=forward(junction_heading);wanted.x-=f.x*22;wanted.y-=f.y*22;}
        else if(local_car||bike){
            const float car_along[]={16,31,47,-15},bike_along[]={14,-8};
            float along=(bike?bike_along[i-5]:car_along[i-1])+unit(random)*3-1.5f;
            Vec f=forward(origin_heading);wanted=origin;wanted.x+=f.x*along;wanted.y+=f.y*along;
        }
        else if(i>=12&&i<16){
            wanted=origin;float a=unit(random)*6.28318530718f,radius=25+unit(random)*65;
            wanted.x+=cosf(a)*radius;wanted.y+=sinf(a)*radius;
        }else{
            float a=unit(random)*6.28318530718f;
            float radius=i<12?25+unit(random)*70:160+unit(random)*260;
            wanted.x+=cosf(a)*radius;wanted.y+=sinf(a)*radius;
        }
        // Local roles use continuous positions; nearest nodes collapse distinct
        // slots onto the same occupied lane node. Road membership remains real.
        if(local_car||bike){Vec node;float node_h=0;p=wanted;h=origin_heading;if(!road_node(p,node,node_h))continue;p.z=node.z;}
        else if(!road_node(wanted,p,h)||fabsf(p.z-junction.z)>15)continue;
        else if(distance(p,origin)<140){Vec f=forward(origin_heading),v=forward(h);if(f.x*v.x+f.y*v.y<0)h+=180;}
        else if(i%2)h+=180;
        Vec r=right(h);float lateral=bike?(i%2?-1.6f:1.6f):local_car?0.f:1.3f;
        p.x+=r.x*lateral;p.y+=r.y*lateral;
        if(!call<int>(N::IS_POINT_ON_ROAD,p.x,p.y,p.z,0)||distance(p,origin)<(bike?4.f:10.f))continue;
        bool occupied=false;
        Vec f=forward(h);
        for(auto& old:cars){
            float along=fabsf((p.x-old.initial.x)*f.x+(p.y-old.initial.y)*f.y),side=fabsf((p.x-old.initial.x)*r.x+(p.y-old.initial.y)*r.y);
            if(along<(bike?1.2f:2.4f)+(old.bike?1.2f:2.4f)+.2f&&side<(bike?.42f:.95f)+(old.bike?.42f:.95f)+.15f)occupied=true;
        }
        for(auto& old:parked){
            Vec q=vector_call(N::GET_ENTITY_COORDS,old.entity,true);
            float along=fabsf((p.x-q.x)*f.x+(p.y-q.y)*f.y),side=fabsf((p.x-q.x)*r.x+(p.y-q.y)*r.y);
            if(along<(bike?1.2f:2.4f)+2.5f&&side<(bike?.42f:.95f)+.95f+.1f)occupied=true;
        }
        if(occupied)continue;
        uint32_t hash=bike?bike_models[i-5]:vehicle_models[i%8];
        int vehicle=call<int>(N::CREATE_VEHICLE,hash,p.x,p.y,p.z+1.f,h,false,false,false);if(!vehicle)continue;
        call(N::SET_ENTITY_AS_MISSION_ENTITY,vehicle,true,true);call(N::SET_VEHICLE_ON_GROUND_PROPERLY,vehicle,5.f);
        int driver=call<int>(N::CREATE_PED_INSIDE_VEHICLE,vehicle,4,male,-1,false,false);
        if(!driver){call(N::DELETE_VEHICLE,&vehicle);continue;}
        call(N::SET_ENTITY_AS_MISSION_ENTITY,driver,true,true);call(N::SET_BLOCKING_OF_NON_TEMPORARY_EVENTS,driver,true);
        call(N::SET_DRIVER_ABILITY,driver,1.f);call(N::SET_DRIVER_AGGRESSIVENESS,driver,.2f);
        call(N::SET_VEHICLE_ENGINE_ON,vehicle,true,true,false);
        Actor actor;actor.entity=vehicle;actor.driver=driver;actor.bike=bike;actor.local_car=local_car;
        actor.initial=vector_call(N::GET_ENTITY_COORDS,vehicle,true);cars.push_back(actor);
        if(i==0)call(N::TASK_VEHICLE_DRIVE_TO_COORD_LONGRANGE,driver,vehicle,junction.x,junction.y,junction.z,4.f,786603,1.f);
        else if(bike||local_car){
            Vec goal=origin,front=forward(origin_heading);goal.x+=front.x*320;goal.y+=front.y*320;
            call(N::TASK_VEHICLE_DRIVE_TO_COORD_LONGRANGE,driver,vehicle,goal.x,goal.y,goal.z,3.5f,786603,2.f);
        }else call(N::TASK_VEHICLE_DRIVE_WANDER,driver,vehicle,local_car?2.0f:i<40?4.f+unit(random)*2:7.f+unit(random)*2,786603);
        if(i%4==0)scriptWait(0);
    }
    for(int attempt=0;walkers.size()<U::PEDS&&attempt<6000;++attempt){
        if(attempt%25==0)scriptWait(0);
        int i=int(walkers.size());float a=unit(random)*6.28318530718f;
        Vec wanted=i<20?junction:origin,p;
        bool crosser=i>=20&&i<26;
        Vec cross_goal,cross_center,cross_right;float cross_width=0;
        if(crosser){
            Vec front=forward(origin_heading);float along=12+unit(random)*77,h=origin_heading;
            cross_center=origin;cross_center.x+=front.x*along;cross_center.y+=front.y*along;
            if(!center_road(cross_center,h))continue;
            cross_right=right(h);cross_width=road_band(cross_center,h);
            if(cross_width<3||cross_width>12)continue;
            float side=i%2?-1.f:1.f;
            wanted=cross_center;wanted.x+=cross_right.x*side*(cross_width*.5f+1);wanted.y+=cross_right.y*side*(cross_width*.5f+1);
            Vec other=cross_center;other.x-=cross_right.x*side*(cross_width*.5f+1);other.y-=cross_right.y*side*(cross_width*.5f+1);
            if(!call<int>(N::GET_SAFE_COORD_FOR_PED,other.x,other.y,other.z,true,&cross_goal,29))continue;
        }else if(i>=26){
            wanted=junction;float radius=12+unit(random)*70;
            wanted.x+=cosf(a)*radius;wanted.y+=sinf(a)*radius;
        }else{
            float radius=i<20?8+unit(random)*65:80+unit(random)*250;
            wanted.x+=cosf(a)*radius;wanted.y+=sinf(a)*radius;
        }
        if(!call<int>(N::GET_SAFE_COORD_FOR_PED,wanted.x,wanted.y,wanted.z,true,&p,29))continue;
        if(crosser){
            // SafeCoord is a coarse pavement anchor, not a unique spawn point.
            // Spread along it, then check actual ground, body space and road sides.
            Vec front=forward(origin_heading);float offset=unit(random)*6-3;
            p.x+=front.x*offset;p.y+=front.y*offset;
            cross_goal.x+=front.x*offset;cross_goal.y+=front.y*offset;
            if(!grounded(p)||!grounded(cross_goal)||!clear_ped_space(p,origin_heading)||!clear_ped_space(cross_goal,origin_heading))continue;
            float a=(p.x-cross_center.x)*cross_right.x+(p.y-cross_center.y)*cross_right.y;
            float b=(cross_goal.x-cross_center.x)*cross_right.x+(cross_goal.y-cross_center.y)*cross_right.y;
            if(a*b>=0||fabsf(a)<cross_width*.5f||fabsf(b)<cross_width*.5f||distance(p,cross_goal)>20)continue;
            int q=call<int>(N::START_EXPENSIVE_SYNCHRONOUS_SHAPE_TEST_LOS_PROBE,p.x,p.y,p.z+1,cross_goal.x,cross_goal.y,cross_goal.z+1,3,ego,7);
            Vec hit,norm;int blocked=0,entity=0,status=call<int>(N::GET_SHAPE_TEST_RESULT,q,&blocked,&hit,&norm,&entity);
            if(status!=2||blocked)continue;
        }else if(i>=26&&!clear_ped_space(p,origin_heading))continue;
        bool occupied=false;for(auto& old:walkers)if(distance(p,old.initial)<.9f)occupied=true;
        if(occupied)continue;
        int human=call<int>(N::CREATE_PED,4,i%2?female:male,p.x,p.y,p.z,unit(random)*360,false,false);if(!human)continue;
        call(N::SET_ENTITY_AS_MISSION_ENTITY,human,true,true);call(N::SET_BLOCKING_OF_NON_TEMPORARY_EVENTS,human,true);
        if(!crosser)call(N::TASK_WANDER_STANDARD,human,10.f,0);
        Actor actor;actor.entity=human;actor.initial=vector_call(N::GET_ENTITY_COORDS,human,true);actor.crosser=crosser;
        if(crosser){
            actor.cross_start=p;actor.cross_goal=cross_goal;actor.cross_center=cross_center;actor.cross_right=cross_right;actor.cross_width=cross_width;
            actor.cross_speed=1.1f+unit(random)*.8f;actor.due_ms=3000+(uint64_t)(unit(random)*22000);
            crossing_event(actor,"SETUP",actor.initial);
        }
        walkers.push_back(actor);
        if(i%8==0)scriptWait(0);
    }
    return cars.size()==U::CARS&&walkers.size()==U::PEDS;
}
static bool alive(int e){return e&&call<int>(N::DOES_ENTITY_EXIST,e)&&!call<int>(N::IS_ENTITY_DEAD,e,false);}
static void update_crossers(uint64_t now){
    uint64_t elapsed=now-ready_at;
    for(auto& a:walkers)if(a.crosser){
        Vec p=vector_call(N::GET_ENTITY_COORDS,a.entity,true);
        if(!alive(a.entity)){
            if(!a.casualty_logged){crossing_event(a,"CASUALTY",p);a.casualty_logged=true;}
            continue;
        }
        if(!a.cross_active&&elapsed>=a.due_ms){
            a.cross_start=p;
            call(N::CLEAR_PED_TASKS,a.entity);
            call(N::TASK_GO_STRAIGHT_TO_COORD,a.entity,a.cross_goal.x,a.cross_goal.y,a.cross_goal.z,a.cross_speed,24000,0.f,.3f);
            a.cross_active=true;a.entered=false;a.started_ms=elapsed;
            crossing_event(a,"TASK_ASSIGNED",p);
        }
        float lateral=(p.x-a.cross_center.x)*a.cross_right.x+(p.y-a.cross_center.y)*a.cross_right.y;
        if(a.cross_active&&!a.entered&&fabsf(lateral)<a.cross_width*.5f-.25f&&on_road_at_actor(p)){
            a.entered=true;crossing_event(a,"ENTERED_ROAD",p);
        }
        float start_side=(a.cross_start.x-a.cross_center.x)*a.cross_right.x+(a.cross_start.y-a.cross_center.y)*a.cross_right.y;
        float goal_distance=sqrtf(powf(p.x-a.cross_goal.x,2)+powf(p.y-a.cross_goal.y,2));
        if(a.cross_active&&a.entered&&start_side*lateral<0&&fabsf(lateral)>=a.cross_width*.5f-.4f&&goal_distance<1.3f){
            crossing_event(a,"COMPLETED",p);a.cross_active=false;
            std::swap(a.cross_start,a.cross_goal);
            a.due_ms=UINT64_MAX;
        }else if(a.cross_active&&elapsed-a.started_ms>25000){
            crossing_event(a,"STALLED",p);a.cross_active=false;a.due_ms=UINT64_MAX;
        }
    }

}
static bool blocker_released=false;
static void direction_trace(const Snapshot& s){
    FILE* file=nullptr;_wfopen_s(&file,(output_path+L"/flow-evaluation.jsonl").c_str(),L"ab");if(!file)return;
    Vec f=forward(origin_heading);int moving=0,aligned=0;bool first=true;
    fprintf(file,"{\"host_ms\":%llu,\"actor_truth_evaluation_only\":true,\"local\":[",s.host_ms);
    for(auto& a:cars)if(a.local_car||a.bike){
        Vec v=vector_call(N::GET_ENTITY_VELOCITY,a.entity);float speed=call<float>(N::GET_ENTITY_SPEED,a.entity),along=v.x*f.x+v.y*f.y;
        if(speed>.5f){++moving;if(along>0)++aligned;}
        fprintf(file,"%s{\"bike\":%s,\"speed_mps\":%.5f,\"along_mps\":%.5f}",first?"":",",a.bike?"true":"false",speed,along);first=false;
    }
    fprintf(file,"],\"moving\":%d,\"aligned\":%d,\"blocker_released\":%s}\n",moving,aligned,blocker_released?"true":"false");fclose(file);
}
static void population_trace(const Snapshot& s){
    direction_trace(s);
    int count=0,peds=0,on_foot=0,cars_moved=0,peds_moved=0,near_slow=0,away_moving=0,near_queue_from_moving=0,visible_cars=0,visible_peds=0;
    int bikes=0,bikes_moved=0,local_cars=0,local_cars_moved=0,road_crossers=0;
    for(auto& a:cars)if(alive(a.entity)){
        ++count;Vec p=vector_call(N::GET_ENTITY_COORDS,a.entity,true);float speed=call<float>(N::GET_ENTITY_SPEED,a.entity),d=distance(p,origin);
        if(distance(p,a.initial)>.5f)++cars_moved;
        bool moved=distance(p,a.initial)>2;
        if(a.bike&&call<int>(N::IS_THIS_MODEL_A_BIKE,call<uint32_t>(N::GET_ENTITY_MODEL,a.entity))){++bikes;if(moved)++bikes_moved;}
        if(a.local_car){++local_cars;if(moved)++local_cars_moved;}
        if(call<int>(N::IS_ENTITY_ON_SCREEN,a.entity)&&!call<int>(N::IS_ENTITY_OCCLUDED,a.entity)&&distance(p,s.camera)<60)++visible_cars;
        if(!blocker_stopped&&speed>1)a.moving_before_block=true;
        if(d<=70&&speed<.5f){++near_slow;if(a.entity!=cars[0].entity&&a.moving_before_block)++near_queue_from_moving;}
        if(d>=110&&speed>1)++away_moving;
    }
    for(auto& a:walkers)if(alive(a.entity)){
        ++peds;if(!call<int>(N::IS_PED_IN_ANY_VEHICLE,a.entity,false))++on_foot;
        if(distance(vector_call(N::GET_ENTITY_COORDS,a.entity,true),a.initial)>.5f)++peds_moved;
        if(call<int>(N::IS_ENTITY_ON_SCREEN,a.entity)&&!call<int>(N::IS_ENTITY_OCCLUDED,a.entity)&&distance(vector_call(N::GET_ENTITY_COORDS,a.entity,true),s.camera)<50)++visible_peds;
        if(a.crosser){
            Vec p=vector_call(N::GET_ENTITY_COORDS,a.entity,true);
            float side=(p.x-a.cross_center.x)*a.cross_right.x+(p.y-a.cross_center.y)*a.cross_right.y;
            if(fabsf(side)<a.cross_width*.5f-.25f&&on_road_at_actor(p))++road_crossers;
        }
    }
    Vec blocker=cars.empty()?Vec{}:vector_call(N::GET_ENTITY_COORDS,cars[0].entity,true);
    FILE* f=nullptr;_wfopen_s(&f,(output_path+L"/urban.jsonl").c_str(),L"ab");if(!f)return;
    fprintf(f,"{\"run_id\":\"%s\",\"pid\":%u,\"frame\":%u,\"host_ms\":%llu,\"game_ms\":%u,\"elapsed_s\":%.3f,"
        "\"cars_alive\":%d,\"pedestrians_alive\":%d,\"pedestrians_on_foot\":%d,\"cars_moved\":%d,\"pedestrians_moved\":%d,"
        "\"near_slow\":%d,\"near_queue_from_moving\":%d,\"away_moving\":%d,\"visible_cars\":%d,\"visible_pedestrians\":%d,"
        "\"motorcycles_alive\":%d,\"motorcycles_moved_2m\":%d,\"local_cars_alive\":%d,\"local_cars_moved_2m\":%d,\"road_crossers\":%d,"
        "\"blocker_stopped\":%s,\"blocker_entity\":%d,\"ego_on_road\":%s,"
        "\"road_membership_width_m\":%.2f,\"street_name\":\"%s\",\"junction_name\":\"%s\","
        "\"ego_spawn\":[%.5f,%.5f,%.5f],\"junction\":[%.5f,%.5f,%.5f],\"blocker_position\":[%.5f,%.5f,%.5f],\"actor_truth_evaluation_only\":true,\"initial_local_group\":[",
        s.run,s.pid,s.frame,s.host_ms,s.game_ms,float(s.host_ms-ready_at)/1000,count,peds,on_foot,cars_moved,peds_moved,
        near_slow,near_queue_from_moving,away_moving,visible_cars,visible_peds,bikes,bikes_moved,local_cars,local_cars_moved,road_crossers,
        blocker_stopped?"true":"false",cars.empty()?0:cars[0].entity,
        on_road_at_actor(s.position)?"true":"false",band,street_name.c_str(),junction_name.c_str(),
        origin.x,origin.y,origin.z,junction.x,junction.y,junction.z,blocker.x,blocker.y,blocker.z);
    int local_index=0;Vec axis_f=forward(origin_heading),axis_r=right(origin_heading);
    for(auto& a:cars)if(a.bike||a.local_car){
        float dx=a.initial.x-origin.x,dy=a.initial.y-origin.y;
        fprintf(f,"%s{\"entity\":%d,\"role\":\"%s\",\"along_m\":%.5f,\"lateral_m\":%.5f,\"position\":[%.5f,%.5f,%.5f]}",
            local_index++?",":"",a.entity,a.bike?"MOTORCYCLE":"LOCAL_CAR",dx*axis_f.x+dy*axis_f.y,dx*axis_r.x+dy*axis_r.y,
            a.initial.x,a.initial.y,a.initial.z);
    }
    fprintf(f,"]}");fputc(10,f);fclose(f);parking_trace(s);
}
static bool reverse_requested=false;
static void scan(const Snapshot& s,int ego){
    FILE* f=nullptr;_wfopen_s(&f,(output_path+L"/geometry.jsonl").c_str(),L"ab");if(!f)return;
    Vec scan_origin=s.position;scan_origin.z+=1.1f;
    uint64_t started=GetTickCount64();fprintf(f,"{\"run_id\":\"%s\",\"pid\":%u,\"frame\":%u,\"host_ms\":%llu,\"rays\":[",s.run,s.pid,s.frame,started);
    const float elevations[]={-65.f,-45.f,-35.f,-25.f,-15.f,-8.f,-3.f,0.f,6.f};int count=0;
    for(float elevation:elevations)for(int azimuth=0;azimuth<360;azimuth+=3){
        float a=azimuth*3.14159265359f/180,e=elevation*3.14159265359f/180;Vec d;
        d.x=(s.forward.x*cosf(a)+s.right.x*sinf(a))*cosf(e)+s.up.x*sinf(e);
        d.y=(s.forward.y*cosf(a)+s.right.y*sinf(a))*cosf(e)+s.up.y*sinf(e);
        d.z=(s.forward.z*cosf(a)+s.right.z*sinf(a))*cosf(e)+s.up.z*sinf(e);
        int q=call<int>(N::START_EXPENSIVE_SYNCHRONOUS_SHAPE_TEST_LOS_PROBE,s.position.x,s.position.y,s.position.z+1.1f,
            s.position.x+d.x*100,s.position.y+d.y*100,s.position.z+1.1f+d.z*100,511,ego,7);
        Vec point,norm;int hit=0,entity=0,status=call<int>(N::GET_SHAPE_TEST_RESULT,q,&hit,&point,&norm,&entity);
        float dist=hit?distance(point,scan_origin):(status==2?100.f:-1.f);
        fprintf(f,"%s[%d,%.2f,%d,%d,%.5f,%.5f,%.5f,%.5f,%d]",count++?",":"",azimuth,elevation,status,hit,dist,point.x,point.y,point.z,entity);
    }
    fprintf(f,"],\"scan_ms\":%llu,\"game_ms\":%u,\"position\":[%.6f,%.6f,%.6f],\"forward\":[%.6f,%.6f,%.6f],\"right\":[%.6f,%.6f,%.6f],\"up\":[%.6f,%.6f,%.6f],\"origin_world\":[%.6f,%.6f,%.6f],\"speed_mps\":%.6f,\"longitudinal_speed_mps\":%.6f,\"reverse_requested\":%s,\"steering\":%.5f,\"throttle\":%.5f,\"brake\":%.5f,\"actor_handles_evaluation_only\":true}",GetTickCount64()-started,s.game_ms,s.position.x,s.position.y,s.position.z,s.forward.x,s.forward.y,s.forward.z,s.right.x,s.right.y,s.right.z,s.up.x,s.up.y,s.up.z,scan_origin.x,scan_origin.y,scan_origin.z,s.speed,s.velocity.x*s.forward.x+s.velocity.y*s.forward.y+s.velocity.z*s.forward.z,reverse_requested?"true":"false",s.steer,s.throttle,s.brake);fputc(10,f);fclose(f);
}

static void route_setup(){
    const float goals[][2]={{-100.f,-2250.f},{-30.f,-2200.f},{150.f,-2150.f},{300.f,-1950.f},{300.f,-1750.f}, {-350.f,-1200.f},{-250.f,-1150.f}};
    FILE* file=nullptr;_wfopen_s(&file,(output_path+L"/route-map.jsonl").c_str(),L"ab");
    FILE* debug=nullptr;_wfopen_s(&debug,(output_path+L"/route-attempts.jsonl").c_str(),L"ab");
    if(!file)return;
    for(auto& xy:goals){
        Vec target;target.x=xy[0];target.y=xy[1];target.z=origin.z;Vec node;float heading=0;
        if(road_node(target,node,heading))target=node;
        call(N::SET_NEW_WAYPOINT,target.x,target.y);for(int k=0;k<40;++k)scriptWait(25);
        int length=call<int>(N::GET_GPS_BLIP_ROUTE_LENGTH);
        for(int route_type=0;route_type<3;++route_type){
            std::vector<Vec> points;
            for(float d=0;d<=1000;d+=3){
                Vec p;if(!call<int>(N::GET_POS_ALONG_GPS_TYPE_ROUTE,&p,true,d,route_type))break;
                if(!points.empty()&&distance(points.back(),p)<.05f)break;
                points.push_back(p);
                if(d>30&&distance(p,target)<5)break;
            }
            float arc=0;bool valid=points.size()>=30;
            for(size_t i=1;i<points.size();++i){float delta=distance(points[i],points[i-1]);if(!std::isfinite(delta)||delta>12)valid=false;arc+=delta;}
            float end=points.empty()?1e9f:distance(points.back(),target),start=points.empty()?1e9f:distance(points.front(),origin);
            Vec direction=forward(origin_heading);float ahead=points.size()>5?(points[5].x-points[0].x)*direction.x+(points[5].y-points[0].y)*direction.y:-1e9f;
            if(debug){fprintf(debug,"{\"target\":[%.3f,%.3f,%.3f],\"route_type\":%d,\"blip_length_m\":%d,\"sampled_points\":%zu,\"arc_m\":%.5f,\"start_gap_m\":%.5f,\"end_gap_m\":%.5f,\"first15m_ahead_m\":%.5f}\n",target.x,target.y,target.z,route_type,length,points.size(),arc,start,end,ahead);fflush(debug);}
            if(!valid||arc<600||arc>800||start>25||end>15||ahead<5)continue;
            fprintf(file,"{\"source\":\"STATIC_GPS_MAP_PRIOR_NOT_ACTORS\",\"route_length_m\":%.5f,\"gps_length_m\":%d,\"destination\":[%.5f,%.5f,%.5f],\"points\":[",arc,length,points.back().x,points.back().y,points.back().z);
            for(size_t i=0;i<points.size();++i)fprintf(file,"%s[%.5f,%.5f,%.5f]",i?",":"",points[i].x,points[i].y,points[i].z);
            fprintf(file,"]}\n");fclose(file);if(debug)fclose(debug);return;
        }
    }
    fprintf(file,"{\"error\":\"GPS_ROUTE_NOT_QUALIFIED\"}\n");fclose(file);if(debug)fclose(debug);
}

static void diagnostic(){
    wchar_t path[2048]={};char nonce[33]={},run[33]={},port_text[16]={};
    if(!GetEnvironmentVariableW(L"OSTORHA_SENSOR_OUTPUT",path,2048)||!GetEnvironmentVariableA("OSTORHA_SENSOR_OWNER",nonce,33)||
       !GetEnvironmentVariableA("OSTORHA_BOOTSTRAP_ID",run,33)||!GetEnvironmentVariableA("OSTORHA_SENSOR_PORT",port_text,16))return;
    output_path=path;strcpy_s(current_run,run);Snapshot s;s.pid=GetCurrentProcessId();strcpy_s(s.run,run);strcpy_s(s.stage,"INITIALIZING");trace(s);
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
    if(!choose_site(ped)){strcpy_s(s.stage,"SPAWN_FAILED");trace(s);return;}
    uint32_t car_model=model("blista");if(!car_model){strcpy_s(s.stage,"MODEL_FAILED");trace(s);return;}
    Vec minimum,maximum;call(N::GET_MODEL_DIMENSIONS,car_model,&minimum,&maximum);ego_width=maximum.x-minimum.x;
    Vec start=origin,r=right(origin_heading);start.x+=r.x*.25f;start.y+=r.y*.25f;
    call(N::CLEAR_AREA_OF_VEHICLES,origin.x,origin.y,origin.z,450.f,false,false,false,false,false,false,0);
    int ego=call<int>(N::CREATE_VEHICLE,car_model,start.x,start.y,start.z+1.f,origin_heading,false,false,false);
    if(!ego){strcpy_s(s.stage,"SPAWN_FAILED");trace(s);return;}
    call(N::SET_ENTITY_AS_MISSION_ENTITY,ego,true,true);call(N::SET_VEHICLE_ON_GROUND_PROPERLY,ego,5.f);
    call(N::SET_PED_INTO_VEHICLE,ped,ego,-1);call(N::SET_VEHICLE_ENGINE_ON,ego,true,true,false);call(N::SET_VEHICLE_HANDBRAKE,ego,true);
    if(!populate(ego)){strcpy_s(s.stage,"SPAWN_FAILED");s.host_ms=GetTickCount64();population_trace(s);trace(s);return;}
    route_setup();
    int lf=call<int>(N::GET_ENTITY_BONE_INDEX_BY_NAME,ego,"wheel_lf"),lr=call<int>(N::GET_ENTITY_BONE_INDEX_BY_NAME,ego,"wheel_lr");
    Vec front_wheel=vector_call(N::GET_WORLD_POSITION_OF_ENTITY_BONE,ego,lf),rear_wheel=vector_call(N::GET_WORLD_POSITION_OF_ENTITY_BONE,ego,lr);
    FILE* shape=nullptr;_wfopen_s(&shape,(output_path+L"/ego-geometry.json").c_str(),L"wb");
    if(shape){fprintf(shape,"{\"front_m\":%.6f,\"rear_m\":%.6f,\"half_width_m\":%.6f,\"wheelbase_m\":%.6f,\"source\":\"NATIVE_SELF_MODEL_BOUNDS_AND_WHEEL_BONES\",\"steer_response_qualified\":false,\"lower_model_z\":%.6f}",maximum.y,-minimum.y,ego_width*.5f,lf>=0&&lr>=0?distance(front_wheel,rear_wheel):0.f,minimum.z);fclose(shape);}
    ready_at=GetTickCount64();int camera=call<int>(N::CREATE_CAM,"DEFAULT_SCRIPTED_CAMERA",true);
    call(N::SET_CAM_FOV,camera,60.f);call(N::SET_CAM_NEAR_CLIP,camera,.15f);call(N::SET_CAM_FAR_CLIP,camera,150.f);
    call(N::RENDER_SCRIPT_CAMS,true,false,0,true,false,0);
    Command latest{};uint64_t command_input_sequence=0,last_applied_sequence=0;uint64_t sequence=0,last_trace=0,last_population=0;uint16_t owner_port=0;
    uint32_t replay=0,stale=0,wrong_owner=0;
    for(;;){
        uint64_t now=GetTickCount64();read_driving_input(now,call<uint32_t>(N::GET_FRAME_COUNT),run);s.phase_s=float(now-ready_at)/1000;
        update_crossers(now);
        strcpy_s(s.stage,now-ready_at>U::DURATION_MS?"DONE":blocker_stopped&&!blocker_released?"CITY_LOCAL_JAM":"CITY_FLOW");
        call(N::SET_GAME_PAUSED,false);call(N::SET_PAUSE_MENU_ACTIVE,false);
        call(N::SET_PED_DENSITY_MULTIPLIER_THIS_FRAME,0.f);call(N::SET_VEHICLE_DENSITY_MULTIPLIER_THIS_FRAME,0.f);
        call(N::SET_MAX_WANTED_LEVEL,0);call(N::SET_PLAYER_WANTED_LEVEL,player,0,false);call(N::SET_PLAYER_WANTED_LEVEL_NOW,player,false);
        call(N::SET_POLICE_IGNORE_PLAYER,player,true);wanted_level=call<int>(N::GET_PLAYER_WANTED_LEVEL,player);
        s.ped_alive=alive(ped);if(!s.ped_alive){strcpy_s(s.stage,"DRIVER_DIED");trace(s);break;}
        if(!blocker_stopped&&now-ready_at>8000&&distance(vector_call(N::GET_ENTITY_COORDS,cars[0].entity,true),junction)<=12){
            blocker_stopped=true;call(N::CLEAR_PED_TASKS,cars[0].driver);
        }
        if(blocker_stopped){
            bool held=now-ready_at<33000;
            call(N::SET_VEHICLE_HANDBRAKE,cars[0].entity,held);
            if(!held&&!blocker_released){
                blocker_released=true;Vec goal=origin,f=forward(origin_heading);goal.x+=f.x*320;goal.y+=f.y*320;
                call(N::TASK_VEHICLE_DRIVE_TO_COORD_LONGRANGE,cars[0].driver,cars[0].entity,goal.x,goal.y,goal.z,4.f,786603,2.f);
            }
        }
        call(N::GET_ENTITY_MATRIX,ego,&s.forward,&s.right,&s.up,&s.position);
        s.velocity=vector_call(N::GET_ENTITY_VELOCITY,ego);s.speed=call<float>(N::GET_ENTITY_SPEED,ego);
        s.heading=call<float>(N::GET_ENTITY_HEADING,ego);s.body_health=call<float>(N::GET_VEHICLE_BODY_HEALTH,ego);
        s.camera=s.position;s.camera.x+=s.forward.x*1.5f+s.up.x*1.25f;s.camera.y+=s.forward.y*1.5f+s.up.y*1.25f;s.camera.z+=s.forward.z*1.5f+s.up.z*1.25f;
        Vec rotation=vector_call(N::GET_ENTITY_ROTATION,ego,2);call(N::SET_CAM_COORD,camera,s.camera.x,s.camera.y,s.camera.z);call(N::SET_CAM_ROT,camera,rotation.x,rotation.y,rotation.z,2);
        s.fov=call<float>(N::GET_FINAL_RENDERED_CAM_FOV);s.near_clip=call<float>(N::GET_FINAL_RENDERED_CAM_NEAR_CLIP);s.far_clip=call<float>(N::GET_FINAL_RENDERED_CAM_FAR_CLIP);
        for(int j=0;j<64;++j){
            GoalCommand packet{};Command& in=packet.base;sockaddr_in sender{};int size=sizeof(sender);int bytes=recvfrom(sock,(char*)&packet,sizeof(packet),0,(sockaddr*)&sender,&size);if(bytes==SOCKET_ERROR)break;
            if(bytes!=sizeof(packet)||in.magic!=0x4f475431||in.version!=2||in.type<1||in.type>4||sender.sin_addr.s_addr!=htonl(INADDR_LOOPBACK)||
               memcmp(in.owner,nonce,33)||(owner_port&&owner_port!=sender.sin_port)){++wrong_owner;continue;}
            if((human_mode!=(in.type>=3))||!packet.source_frame||packet.source_frame>call<uint32_t>(N::GET_FRAME_COUNT)){++wrong_owner;continue;}
            if(human_mode&&(packet.input_sequence<mode_first_sequence||packet.input_sequence>input_sequence||input_sequence-packet.input_sequence>=32||now-input_times[packet.input_sequence%32]>150)){++stale;continue;}
            if(in.deadline_ms<now||in.deadline_ms>now+150){++stale;continue;}
            if(in.sequence<=sequence){++replay;continue;}
            if(!std::isfinite(in.steer)||!std::isfinite(in.throttle)||!std::isfinite(in.brake)||fabs(in.steer)>1||in.throttle<0||in.throttle>1||in.brake<0||in.brake>1){++wrong_owner;continue;}
            latest=in;command_input_sequence=packet.input_sequence;sequence=in.sequence;owner_port=sender.sin_port;
        }
        s.host_ms=now;s.frame=call<uint32_t>(N::GET_FRAME_COUNT);s.game_ms=call<uint32_t>(N::GET_GAME_TIMER);s.sequence=sequence;
        s.capture_ms=InterlockedCompareExchange64(&captured_at,0,0);s.lease_expired=now>latest.deadline_ms;s.sensor_stale=!s.capture_ms||now-s.capture_ms>350;
        s.steer=latest.steer;s.throttle=latest.throttle;s.brake=latest.brake;
        if(s.speed>2.5f){s.throttle=0;s.brake=std::max(s.brake,.35f);}
        bool input_expired=human_mode&&(!input_focused||command_input_sequence<mode_first_sequence||command_input_sequence>input_sequence||input_sequence-command_input_sequence>=32||now-input_times[command_input_sequence%32]>150);
        bool mode_mismatch=human_mode!=(latest.type>=3);
        bool intent_changed=human_mode&&s.throttle>0&&((latest.type==3&&input_w<=0)||(latest.type==4&&input_s<=0)||(s.steer*input_steer<0)||(fabsf(s.steer)>.01f&&fabsf(input_steer)<.01f));
        if(s.lease_expired||s.sensor_stale||input_expired||mode_mismatch||intent_changed||!strcmp(s.stage,"DONE")){s.steer=0;s.throttle=0;s.brake=1;}
        for(int control:{59,60,63,64,71,72,73,75,76})call(N::DISABLE_CONTROL_ACTION,0,control,true);
        for(int control:{59,71,72})call(N::ENABLE_CONTROL_ACTION,0,control,true);
        call(N::SET_VEHICLE_HANDBRAKE,ego,s.brake>=.99f);call(N::SET_CONTROL_VALUE_NEXT_FRAME,0,59,s.steer);
        bool reversing=latest.type==2||latest.type==4;reverse_requested=reversing;
        call(N::SET_CONTROL_VALUE_NEXT_FRAME,0,71,reversing?0.f:s.throttle);
        call(N::SET_CONTROL_VALUE_NEXT_FRAME,0,72,s.brake>=.99f?0.f:reversing?s.throttle:s.brake);
        
        // Requested game inputs never bypass the single bridge command owner.
        if(sequence!=last_applied_sequence){
            FILE* applied=nullptr;_wfopen_s(&applied,(output_path+L"/applied-controls.jsonl").c_str(),L"ab");
            if(applied){fprintf(applied,"{\"run_id\":\"%s\",\"pid\":%u,\"host_ms\":%llu,\"frame\":%u,\"sequence\":%llu,\"input_sequence\":%llu,\"mode_epoch\":%llu,\"human\":%s,\"steering\":%.5f,\"throttle\":%.5f,\"brake\":%.5f,\"reverse\":%s,\"speed_mps\":%.5f,\"contact\":%s}\n",run,s.pid,now,s.frame,sequence,command_input_sequence,mode_epoch,human_mode?"true":"false",s.steer,s.throttle,s.brake,reversing?"true":"false",s.speed,call<int>(N::HAS_ENTITY_COLLIDED_WITH_ANYTHING,ego)?"true":"false");fclose(applied);}
            last_applied_sequence=sequence;
        }
        s.rejected_replay=replay;s.rejected_stale=stale;s.rejected_owner=wrong_owner;s.contact=call<int>(N::HAS_ENTITY_COLLIDED_WITH_ANYTHING,ego);
        if(now-last_trace>=100){trace(s);scan(s,ego);last_trace=GetTickCount64();}
        if(now-last_population>=1000){population_trace(s);last_population=now;}
        AcquireSRWLockExclusive(&state_lock);state=s;ReleaseSRWLockExclusive(&state_lock);
        if(!strcmp(s.stage,"DONE")){trace(s);break;}
        scriptWait(0);
    }
    call(N::SET_VEHICLE_HANDBRAKE,ego,true);closesocket(sock);WSACleanup();
}
BOOL APIENTRY DllMain(HMODULE module,DWORD reason,LPVOID){
    if(reason==DLL_PROCESS_ATTACH){DisableThreadLibraryCalls(module);keyboardHandlerRegister(on_key);scriptRegister(module,diagnostic);}
    else if(reason==DLL_PROCESS_DETACH){keyboardHandlerUnregister(on_key);scriptUnregister(module);}return TRUE;
}
