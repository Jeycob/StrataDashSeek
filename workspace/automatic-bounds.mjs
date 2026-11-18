// Bounds observation, never claims that a timed-out operation was cancelled.
export const automaticBound=(promise,deadline)=>new Promise(resolve=>{
 const ms=Math.max(0,deadline-Date.now());
 // Always consume a late rejection, including an already expired wait.
 const observed=Promise.resolve(promise);void observed.catch(()=>{});
 if(!ms){resolve(false);return;}
 const timer=setTimeout(()=>resolve(false),ms);
 observed.then(()=>{clearTimeout(timer);resolve(true);},()=>{clearTimeout(timer);resolve(false);});
});
