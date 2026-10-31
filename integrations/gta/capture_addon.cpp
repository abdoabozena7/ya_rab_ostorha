// Actual ReShade API capture. The render thread never calls Script Hook natives.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <reshade.hpp>
#include <vector>
#include <string>
#include <cstdio>
#include <cmath>
#include "sensor_shared.hpp"
extern "C" __declspec(dllexport) const char* NAME="Ostorha capture qualification";
extern "C" __declspec(dllexport) const char* DESCRIPTION="RGB/raw-depth acquisition with actual native frame association";
using namespace reshade::api;
static uint64_t last_capture=0,serial=0;
static bool write_blob(const std::wstring& path,const void* data,size_t length){
    std::wstring temp=path+L".tmp";HANDLE h=CreateFileW(temp.c_str(),GENERIC_WRITE,0,nullptr,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr);
    if(h==INVALID_HANDLE_VALUE)return false;DWORD written=0;bool ok=WriteFile(h,data,DWORD(length),&written,nullptr)&&written==length;CloseHandle(h);
    return ok&&MoveFileExW(temp.c_str(),path.c_str(),MOVEFILE_REPLACE_EXISTING);
}
static bool get_depth(effect_runtime* runtime,std::vector<float>& out,uint32_t width,uint32_t height){
    auto variable=runtime->find_texture_variable("OstorhaDepth.fx","OstorhaRawDepth");if(!variable.handle)return false;
    resource_view srv{},srgb{};runtime->get_texture_binding(variable,&srv,&srgb);if(!srv.handle)return false;
    auto device=runtime->get_device();auto resource=device->get_resource_from_view(srv);if(!resource.handle)return false;
    auto desc=device->get_resource_desc(resource);if(desc.texture.format!=format::r32_float||desc.texture.width!=width||desc.texture.height!=height)return false;
    uint32_t row=(width+63)&~63;uint64_t size=uint64_t(row)*height*4;reshade::api::resource staging{};
    resource_desc buffer(size,memory_heap::gpu_to_cpu,resource_usage::copy_dest);
    if(!device->create_resource(buffer,nullptr,resource_usage::copy_dest,&staging))return false;
    auto queue=runtime->get_command_queue();auto cmd=queue->get_immediate_command_list();
    cmd->barrier(resource,resource_usage::shader_resource,resource_usage::copy_source);
    cmd->copy_texture_to_buffer(resource,0,nullptr,staging,0,row,height);
    cmd->barrier(resource,resource_usage::copy_source,resource_usage::shader_resource);
    queue->flush_immediate_command_list();queue->wait_idle();void* data=nullptr;bool ok=false;
    if(device->map_buffer_region(staging,0,size,map_access::read_only,&data)){
        out.resize(640*360);for(uint32_t y=0;y<360;++y)for(uint32_t x=0;x<640;++x)
            out[y*640+x]=((float*)data)[uint64_t(y)*height/360*row+uint64_t(x)*width/640];
        device->unmap_buffer_region(staging);ok=true;
    }
    device->destroy_resource(staging);return ok;
}
static void capture(effect_runtime* runtime){
    uint64_t now=GetTickCount64();if(now-last_capture<100)return;last_capture=now;
    HMODULE bridge=GetModuleHandleW(L"OstorhaSensor.asi");if(!bridge)return;
    auto get=(GetSnapshot)GetProcAddress(bridge,"OstorhaGetSnapshot");auto publish=(PublishCapture)GetProcAddress(bridge,"OstorhaPublishCapture");
    Snapshot snapshot;if(!get||!publish||!get(&snapshot)||snapshot.pid!=GetCurrentProcessId())return;
    wchar_t folder[2048]={};if(!GetEnvironmentVariableW(L"OSTORHA_SENSOR_OUTPUT",folder,2048))return;std::wstring root=folder;
    if(GetFileAttributesW((root+L"\\drop-capture").c_str())!=INVALID_FILE_ATTRIBUTES)return;
    uint32_t width=0,height=0;runtime->get_screenshot_width_and_height(&width,&height);
    if(width<640||height<360||width>4096||height>2160)return;
    auto desc=runtime->get_device()->get_resource_desc(runtime->get_current_back_buffer());
    auto fmt=desc.texture.format;bool bgra=fmt==format::b8g8r8a8_unorm||fmt==format::b8g8r8a8_unorm_srgb;
    bool rgba=fmt==format::r8g8b8a8_unorm||fmt==format::r8g8b8a8_unorm_srgb;
    bool rgb10=fmt==format::r10g10b10a2_unorm;
    if(!bgra&&!rgba&&!rgb10){ // Unsupported HDR is missing data, not fake SDR.
        char status[256];int bytes=sprintf_s(status,"{\"error\":\"Unsupported backbuffer format\",\"format\":%u,\"width\":%u,\"height\":%u}",(uint32_t)fmt,width,height);
        write_blob(root+L"\\renderer-status.json",status,bytes);return;
    }
    std::vector<unsigned char> full(uint64_t(width)*height*4),rgb(640*360*3);std::vector<float> depth;
    if(!runtime->capture_screenshot(full.data()))return;
    for(uint32_t y=0;y<360;++y)for(uint32_t x=0;x<640;++x){
        auto src=&full[(uint64_t(y)*height/360*width+uint64_t(x)*width/640)*4];auto dst=&rgb[(y*640+x)*3];
        if(rgb10){uint32_t packed=*(uint32_t*)src;for(int c=0;c<3;++c)dst[c]=((packed>>(c*10))&1023)*255/1023;}
        else {dst[0]=src[bgra?2:0];dst[1]=src[1];dst[2]=src[bgra?0:2];}
    }
    bool depth_ok=get_depth(runtime,depth,width,height);
    uint64_t finished=GetTickCount64();++serial;wchar_t stem[80];swprintf_s(stem,L"\\capture-%06llu",serial);
    std::wstring base=root+stem;bool rgb_written=write_blob(base+L".rgb",rgb.data(),rgb.size());
    bool depth_written=depth_ok&&write_blob(base+L".depth",depth.data(),depth.size()*4);
    size_t useful=0;float minimum=1,maximum=0;
    if(depth_written)for(float d:depth)if(std::isfinite(d)&&d>1e-8f&&d<1.f-1e-8f){++useful;minimum=std::min(minimum,d);maximum=std::max(maximum,d);}
    if(rgb_written&&depth_written&&useful>32&&maximum-minimum>1e-7f)publish(finished);
    FILE* file=nullptr;_wfopen_s(&file,(root+L"\\capture.jsonl").c_str(),L"ab");if(!file)return;
    fprintf(file,"{\"serial\":%llu,\"run_id\":\"%s\",\"pid\":%u,\"native_frame\":%u,\"game_ms\":%u,\"native_host_ms\":%llu,\"capture_start_ms\":%llu,\"capture_end_ms\":%llu,\"stage\":\"%s\",\"phase_s\":%.3f,\"width\":640,\"height\":360,\"source_width\":%u,\"source_height\":%u,\"source_format\":%u,\"rgb_ok\":%s,\"depth_ok\":%s,\"ray_status\":%d,\"ray_hit\":%d,\"ray_entity\":%d,\"target\":%d,\"hidden_target\":%d,\"ray_distance_m\":%.5f,\"project_xy\":[%.6f,%.6f],\"near\":%.5f,\"far\":%.5f}\n",
      serial,snapshot.run,snapshot.pid,snapshot.frame,snapshot.game_ms,snapshot.host_ms,now,finished,snapshot.stage,snapshot.phase_s,width,height,(uint32_t)fmt,
      rgb_written?"true":"false",depth_written?"true":"false",snapshot.ray_status,snapshot.ray_hit,snapshot.ray_entity,snapshot.target,snapshot.hidden_target,snapshot.ray_distance,snapshot.project_x,snapshot.project_y,snapshot.near_clip,snapshot.far_clip);
    fclose(file);
}
BOOL WINAPI DllMain(HMODULE self,DWORD reason,LPVOID){
    if(reason==DLL_PROCESS_ATTACH){DisableThreadLibraryCalls(self);if(!reshade::register_addon(self))return FALSE;
        reshade::register_event<reshade::addon_event::reshade_present>(&capture);}
    else if(reason==DLL_PROCESS_DETACH)reshade::unregister_addon(self);return TRUE;
}
