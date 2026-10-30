export interface ByteRange {start:number;end:number}
export function parseRange(header:string|null,size:number):ByteRange|null|'invalid' {
  if(!header)return null;
  const match=/^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if(!match||(!match[1]&&!match[2])||size<=0)return 'invalid';
  let start:number,end:number;
  if(!match[1]) {const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return 'invalid';start=Math.max(0,size-suffix);end=size-1;}
  else {start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),size-1):size-1;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||start>=size)return 'invalid';
  return {start,end};
}
