// Pure raw-depth copy to an owned R32F resource; no color/postprocessing effect.
texture2D SceneDepth : DEPTH;
sampler2D SceneSampler {Texture=SceneDepth;MinFilter=POINT;MagFilter=POINT;MipFilter=POINT;};
texture2D OstorhaRawDepth {Width=BUFFER_WIDTH;Height=BUFFER_HEIGHT;Format=R32F;};
void VS(uint id:SV_VertexID,out float4 position:SV_Position,out float2 uv:TEXCOORD){
    uv=float2((id<<1)&2,id&2);position=float4(uv*float2(2,-2)+float2(-1,1),0,1);
}
float PS(float4 position:SV_Position,float2 uv:TEXCOORD):SV_Target{
    return tex2Dlod(SceneSampler,float4(uv,0,0)).r;
}
technique OstorhaDepth {pass {VertexShader=VS;PixelShader=PS;RenderTarget=OstorhaRawDepth;}}
