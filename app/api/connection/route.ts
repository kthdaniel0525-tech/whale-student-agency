import {validKey,availableModel,fail,GeminiError} from '@/lib/gemini';
export async function POST(req:Request){
 try{
 if(req.headers.get('origin')&&req.headers.get('origin')!==new URL(req.url).origin)throw new GeminiError('허용되지 않은 요청입니다.',403);
 const raw=await req.text();if(raw.length>2000)throw new GeminiError('요청이 너무 큽니다.',413);
 let body;try{body=JSON.parse(raw);}catch{throw new GeminiError('올바르지 않은 요청입니다.',400);}
 const key=validKey(body?.key);const model=await availableModel(key);
 return Response.json({model,message:'키 인증 및 모델 조회 완료. 분석 가능 여부는 Google의 사용량·권한에 따라 달라집니다.'},{headers:{'Cache-Control':'no-store'}});
 }catch(e){return fail(e);}
}
