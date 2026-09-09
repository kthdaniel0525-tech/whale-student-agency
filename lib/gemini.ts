import {z} from 'zod';
export class GeminiError extends Error {
 constructor(message:string,public status=502){super(message);}
}
export function validKey(value:unknown):string {
 if(typeof value!=='string'||!value.trim())throw new GeminiError('Google AI Studio에서 발급받은 API 키를 입력하세요.',400);
 const key=value.trim();
 if(/https?:\/\/|aistudio\.google\.com|generativelanguage\.googleapis\.com/i.test(key))throw new GeminiError('웹주소가 입력되었습니다. 이 칸에는 Google AI Studio에서 발급받은 비밀 API 키를 넣어야 합니다. API 주소는 앱에 이미 연결되어 있습니다.',400);
 if(key.length>512||/\s/.test(key))throw new GeminiError('API 키에 공백이나 줄바꿈이 포함되어 있습니다. 키 값만 다시 복사해 주세요.',400);
 return key;
}
export async function googleError(response:Response):Promise<never>{
 // Read only a machine error reason; never forward Google messages that could contain a key or code.
 const data=await response.json().catch(()=>null) as {error?:{details?:{reason?:string}[]}}|null;
 const reason=data?.error?.details?.map(d=>d.reason).find(Boolean);
 if(reason==='API_KEY_INVALID'||reason==='API_KEY_EXPIRED')throw new GeminiError('API 키가 올바르지 않거나 만료되었습니다. Google AI Studio에서 키를 다시 발급받아 입력하세요.',401);
 if(response.status===429)throw new GeminiError('Google 사용량 한도 또는 결제 한도에 도달했습니다 (429). AI Studio에서 프로젝트의 할당량·결제를 확인하세요. 한도가 0이면 기다리는 것만으로 해결되지 않습니다.',429);
 if(response.status===401||response.status===403)throw new GeminiError('Google이 API 접근을 거부했습니다. 키의 프로젝트, API 사용 권한, 키 제한 및 지원 지역을 확인하세요.',403);
 if(response.status===404)throw new GeminiError('선택한 Gemini 모델을 사용할 수 없습니다. AI 연결에서 다시 연결 확인을 눌러 주세요.',404);
 if(response.status===400)throw new GeminiError('Google이 요청을 거부했습니다 (400). 키의 유효성과 모델의 JSON 출력 지원 여부를 확인하세요.',400);
 throw new GeminiError('Google 서버가 응답하지 않습니다. 잠시 후 다시 시도하세요.');
}
export async function availableModel(key:string,preferred?:string){
 let page='';const names:string[]=[];
 for(let i=0;i<10;i++){
 const url=new URL('https://generativelanguage.googleapis.com/v1beta/models');url.searchParams.set('pageSize','1000');if(page)url.searchParams.set('pageToken',page);
 const res=await fetch(url,{headers:{'x-goog-api-key':key},signal:AbortSignal.timeout(15000)});if(!res.ok)await googleError(res);
 const data=z.object({models:z.array(z.object({name:z.string(),supportedGenerationMethods:z.array(z.string()).optional()})).optional(),nextPageToken:z.string().optional()}).parse(await res.json());
 for(const m of data.models||[])if(m.supportedGenerationMethods?.includes('generateContent')&&/^models\/gemini-[a-z0-9.-]+$/.test(m.name)&&!/(image|tts|audio|robotics|computer-use)/.test(m.name))names.push(m.name.replace('models/',''));
 page=data.nextPageToken||'';if(!page)break;
 }
 if(preferred&&names.includes(preferred))return preferred;
 const ordered=names.sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
 const chosen=ordered.find(n=>/flash/.test(n)&&!/(preview|exp)/.test(n))||ordered.find(n=>/flash/.test(n))||ordered[0];
 if(!chosen)throw new GeminiError('이 API 키에서 코드 분석에 사용할 Gemini 모델을 찾지 못했습니다. Google 프로젝트와 모델 접근 권한을 확인하세요.',400);
 return chosen;
}
export function fail(error:unknown){
 const message=error instanceof GeminiError?error.message:error instanceof Error&&(error.name==='TimeoutError'||error.name==='AbortError')?'Google 응답 시간이 초과되었습니다. 코드를 줄여 다시 시도하세요.':'응답을 처리하지 못했습니다. 잠시 후 다시 시도하세요.';
 return Response.json({error:message},{status:error instanceof GeminiError?error.status:502,headers:{'Cache-Control':'no-store'}});
}
