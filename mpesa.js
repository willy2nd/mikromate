const BASE = process.env.MPESA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
export async function getAccessToken(){ const k=process.env.MPESA_CONSUMER_KEY,s=process.env.MPESA_CONSUMER_SECRET; if(!k||!s) throw new Error("Daraja credentials missing"); const r=await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`,{headers:{Authorization:`Basic ${Buffer.from(`${k}:${s}`).toString("base64")}`}}); if(!r.ok) throw new Error(`OAuth failed ${r.status}`); return (await r.json()).access_token; }
export async function stkPush({phone,amount,accountReference,transactionDesc}){ const token=await getAccessToken(); const sc=process.env.MPESA_SHORTCODE,pk=process.env.MPESA_PASSKEY,cb=process.env.MPESA_CALLBACK_URL; if(!sc||!pk||!cb) throw new Error("Daraja shortcode/passkey/callback missing"); const ts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Nairobi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
}).formatToParts(new Date())
  .reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});

const timestamp =
  `${ts.year}${ts.month}${ts.day}${ts.hour}${ts.minute}${ts.second}`; const password = Buffer.from(`${sc}${pk}${timestamp}`).toString("base64"); const body={BusinessShortCode:sc,Password:password,Timestamp: timestamp,TransactionType:"CustomerPayBillOnline",Amount:Math.round(amount),PartyA:phone,PartyB:sc,PhoneNumber:phone,CallBackURL:cb,AccountReference:String(accountReference).slice(0,12),TransactionDesc:String(transactionDesc).slice(0,20)}; const r=await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(body)}); const j=await r.json(); if(!r.ok) throw new Error(j.errorMessage||`STK failed ${r.status}`); return j; }
