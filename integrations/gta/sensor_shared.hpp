// Shared only by the two project modules in the same GTA process.
#pragma once
#include <windows.h>
#include <cstdint>
struct Vec {float x=0;uint32_t px=0;float y=0;uint32_t py=0;float z=0;uint32_t pz=0;};
struct Snapshot {
    uint32_t magic=0x4f475331,pid=0,frame=0,game_ms=0;
    uint64_t host_ms=0,sequence=0,capture_ms=0;
    char run[33]={},stage[24]={};
    Vec position,velocity,forward,right,up,camera;
    float heading=0,speed=0,body_health=0,fov=60,near_clip=.15f,far_clip=150;
    float steer=0,throttle=0,brake=1,ray_distance=0,project_x=-1,project_y=-1,phase_s=0;
    int ray_status=0,ray_hit=0,ray_entity=0,target=0,hidden_target=0,contact=0,ped_alive=0,target_contact=0;
    uint32_t rejected_replay=0,rejected_stale=0,rejected_owner=0;
    int lease_expired=1,sensor_stale=1;
};
#pragma pack(push,1)
struct Command {
    uint32_t magic=0x4f475431;uint16_t version=1,type=1;
    uint64_t sequence=0,deadline_ms=0;char owner[33]={};
    float steer=0,throttle=0,brake=1;
};
#pragma pack(pop)
static_assert(sizeof(Command)==69,"Command ABI");
using GetSnapshot=bool(*)(Snapshot*);
using PublishCapture=void(*)(uint64_t);
