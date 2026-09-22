import {validKey,availableModel,fail} from '@/lib/gemini';
import { z } from 'zod';
import { api, readJson } from '@/server/api';
import { limitLegacyAI } from '@/server/security/legacy-ai';
export async function POST(req:Request){
 return api(req, async userId => {
 await limitLegacyAI(userId);
 const body = await readJson(req, z.object({ key: z.string().min(1).max(512) }).strict(), 2048);
 try{
 const key=validKey(body?.key);const model=await availableModel(key);
 return Response.json({model,message:'키 인증 및 모델 조회 완료. 분석 가능 여부는 Google의 사용량·권한에 따라 달라집니다.'},{headers:{'Cache-Control':'no-store'}});
 }catch(e){return fail(e);}
 }, false);
}
