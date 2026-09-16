const $ = (id) => document.getElementById(id);
const clamp=(n,min,max)=>Math.min(max,Math.max(min,n));

const state={
  mode:'demo', endpoint:'', pollMs:500, armed:false, source:'RC',
  roll:0,pitch:0,yaw:0,ax:0,ay:0,az:1,gx:0,gy:0,gz:0,
  txVoltage:11.8,rxVoltage:11.6,throttle:0,yawInput:0,pitchInput:0,rollInput:0,
  pot1:50,pot2:50,buttons:[0,0,0,0],packetAge:0,linkQuality:100,lastTelemetry:Date.now(),
  started:Date.now(),logs:[]
};

const channelDefs=[['Throttle','throttle',0,100],['Yaw','yawInput',-100,100],['Pitch','pitchInput',-100,100],['Roll','rollInput',-100,100],['Pot 1','pot1',0,100],['Pot 2','pot2',0,100]];

function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove('show'),2400)}
function logEvent(type,msg,status='OK'){
  state.logs.unshift({time:new Date(),type,msg,status});state.logs=state.logs.slice(0,80);renderLogs();
}
function fmtTime(d){return d.toLocaleTimeString([], {hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});}
function setText(id,val){const el=$(id);if(el)el.textContent=val}

function batteryPct(v){return clamp(Math.round((v-9.9)/(12.6-9.9)*100),0,100)}
function renderChannels(){
  const host=$('overviewChannels');
  host.innerHTML=channelDefs.map(([label,key,min,max])=>{
    const val=state[key]; const pct=((val-min)/(max-min))*100;
    return `<div class="channel"><span>${label}</span><div class="channel-track"><i style="width:${clamp(pct,0,100)}%"></i></div><b>${Math.round(val)}%</b></div>`;
  }).join('');
}
function renderButtons(){
  $('buttonBank').innerHTML=state.buttons.map((v,i)=>`<div class="rc-button ${v?'on':''}">BUTTON ${i+1}<br><b>${v?'ON':'OFF'}</b></div>`).join('');
}
function renderLogs(){
  const compact=state.logs.slice(0,5).map(x=>`<div class="event"><time>${fmtTime(x.time)}</time><p>${x.msg}</p><em>${x.status}</em></div>`).join('');
  $('overviewEvents').innerHTML=compact||'<div class="event"><time>--:--</time><p>No events yet</p><em>READY</em></div>';
  $('fullLog').innerHTML=state.logs.map(x=>`<div class="log-row"><span>${fmtTime(x.time)}</span><span>${x.type}</span><span>${x.msg}</span><span class="log-status">${x.status}</span></div>`).join('');
}

function render(){
  const txPct=batteryPct(state.txVoltage),rxPct=batteryPct(state.rxVoltage);
  setText('rollValue',`${state.roll.toFixed(1)}°`);setText('pitchValue',`${state.pitch.toFixed(1)}°`);setText('yawValue',`${state.yaw.toFixed(1)}°`);
  setText('rollDetail',`${state.roll.toFixed(1)}°`);setText('pitchDetail',`${state.pitch.toFixed(1)}°`);setText('yawDetail',`${state.yaw.toFixed(1)}°`);
  setText('axValue',`${state.ax.toFixed(2)} g`);setText('ayValue',`${state.ay.toFixed(2)} g`);setText('azValue',`${state.az.toFixed(2)} g`);
  setText('gxValue',`${state.gx.toFixed(1)} °/s`);setText('gyValue',`${state.gy.toFixed(1)} °/s`);setText('gzValue',`${state.gz.toFixed(1)} °/s`);
  setText('txVoltage',`${state.txVoltage.toFixed(1)} V`);setText('rxVoltage',`${state.rxVoltage.toFixed(1)} V`);
  setText('txPowerBig',`${state.txVoltage.toFixed(1)} V`);setText('rxPowerBig',`${state.rxVoltage.toFixed(1)} V`);
  setText('txBatteryLabel',`${txPct}% estimated`);setText('rxBatteryLabel',`${rxPct}% estimated`);
  $('txBar').style.width=`${txPct}%`;$('rxBar').style.width=`${rxPct}%`;
  setText('throttleValue',`${Math.round(state.throttle)}%`);$('throttleBar').style.width=`${clamp(state.throttle,0,100)}%`;
  setText('packetAge',`${Math.round(state.packetAge)} ms`);setText('linkQuality',`${Math.round(state.linkQuality)}%`);setText('rfHealth',`${Math.round(state.linkQuality)}%`);
  setText('leftYText',`${Math.round(state.throttle)}%`);setText('leftXText',`${Math.round(state.yawInput)}%`);setText('rightYText',`${Math.round(state.pitchInput)}%`);setText('rightXText',`${Math.round(state.rollInput)}%`);
  $('leftStickDot').style.left=`${50+state.yawInput*.42}%`;$('leftStickDot').style.top=`${90-state.throttle*.8}%`;
  $('rightStickDot').style.left=`${50+state.rollInput*.42}%`;$('rightStickDot').style.top=`${50-state.pitchInput*.42}%`;
  $('pot1Meter').value=state.pot1;$('pot2Meter').value=state.pot2;setText('pot1Text',`${Math.round(state.pot1)}%`);setText('pot2Text',`${Math.round(state.pot2)}%`);
  const world=$('attitudeWorld');world.style.transform=`rotate(${-state.roll}deg) translateY(${state.pitch*1.1}px)`;
  setText('controlSource',state.source==='RC'?'RC TX':'WEB');setText('controlSourceSub',state.source==='RC'?'Physical transmitter priority':'Browser command authority');
  setText('sideMode',state.armed?'ARMED':'STANDBY');setText('flightState',state.armed?'ARMED':'READY');setText('flightSubstate',state.armed?'Control surfaces enabled':'Awaiting arm');setText('armBadge',state.armed?'ARMED':'SAFE');
  $('armBadge').classList.toggle('warn',!state.armed);$('armButton').textContent=state.armed?'DISARM AIRCRAFT':'ARM AIRCRAFT';
  renderChannels();renderButtons();
}

function simulate(){
  if(state.mode!=='demo')return;
  const t=Date.now()/1000;
  state.roll=Math.sin(t*.65)*12+Math.sin(t*.17)*4;
  state.pitch=Math.sin(t*.48)*7;
  state.yaw=(state.yaw+.18)%360;
  state.ax=Math.sin(t*1.1)*.05;state.ay=Math.cos(t*.9)*.04;state.az=1+Math.sin(t*1.4)*.02;
  state.gx=Math.cos(t*.65)*7;state.gy=Math.cos(t*.48)*4;state.gz=.8+Math.sin(t*.5)*.4;
  state.throttle=42+Math.sin(t*.32)*18;
  state.yawInput=Math.sin(t*.43)*30;state.pitchInput=Math.sin(t*.55)*38;state.rollInput=Math.sin(t*.7)*52;
  state.pot1=56+Math.sin(t*.12)*14;state.pot2=71+Math.cos(t*.16)*10;
  state.buttons=[Math.sin(t*.18)>0.92?1:0,0,Math.cos(t*.13)>0.95?1:0,0];
  state.packetAge=10+Math.abs(Math.sin(t*1.8))*24;state.linkQuality=96+Math.sin(t*.22)*3;
  state.txVoltage=11.8+Math.sin(t*.08)*.05;state.rxVoltage=11.6+Math.sin(t*.07)*.08;
  state.lastTelemetry=Date.now();render();
}

async function pollLive(){
  if(state.mode!=='live'||!state.endpoint)return;
  try{
    const res=await fetch(`${state.endpoint.replace(/\/$/,'')}/api/telemetry`,{cache:'no-store'});
    if(!res.ok)throw new Error(`HTTP ${res.status}`);
    const d=await res.json();
    for(const k of Object.keys(state)){if(k in d && typeof state[k]!== 'function')state[k]=d[k];}
    state.lastTelemetry=Date.now();setText('transportText','LIVE LINK');setText('webHealth','ONLINE');setText('lastTelemetry','NOW');render();
  }catch(e){setText('transportText','LINK ERROR');setText('webHealth','OFFLINE');setText('lastTelemetry',`${Math.round((Date.now()-state.lastTelemetry)/1000)}s AGO`);}
}

function wireNav(){
  document.querySelectorAll('.nav-item').forEach(btn=>btn.addEventListener('click',()=>{
    document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active'));btn.classList.add('active');
    document.querySelectorAll('.section').forEach(x=>x.classList.remove('active'));$(btn.dataset.section).classList.add('active');
    const titles={overview:'Mission Overview',instruments:'Flight Instruments',rc:'RC Input Analyzer',power:'Power & Communications',controls:'Web Control Console',logs:'Event & Telemetry Log',settings:'System Settings'};
    setText('pageTitle',titles[btn.dataset.section]);
  }));
  document.querySelectorAll('[data-jump]').forEach(b=>b.addEventListener('click',()=>document.querySelector(`.nav-item[data-section="${b.dataset.jump}"]`).click()));
}

$('armButton').addEventListener('click',()=>{state.armed=!state.armed;logEvent('SAFETY',state.armed?'Aircraft armed':'Aircraft disarmed',state.armed?'ARMED':'SAFE');render();toast(state.armed?'Aircraft ARMED':'Aircraft DISARMED')});
$('failsafeButton').addEventListener('click',()=>{logEvent('FAILSAFE','Failsafe test command requested','TEST');toast('Failsafe test logged — implement receiver-side action before flight')});

document.querySelectorAll('.source').forEach(btn=>btn.addEventListener('click',()=>{
  state.source=btn.dataset.source;document.querySelectorAll('.source').forEach(x=>x.classList.toggle('active',x===btn));$('webControls').classList.toggle('locked',state.source!=='WEB');render();logEvent('CONTROL',`Control authority changed to ${state.source}`,'ACTIVE');
}));
['webThrottle','webAileron','webElevator','webRudder'].forEach(id=>$(id).addEventListener('input',()=>setText(`${id}Text`,`${$(id).value}%`)));
$('centerControl').addEventListener('click',()=>{['webAileron','webElevator','webRudder'].forEach(id=>{$(id).value=0;setText(`${id}Text`,'0%')});toast('Control surfaces centered')});
$('sendControl').addEventListener('click',async()=>{
  if(state.source!=='WEB')return;
  const payload={source:'WEB',throttle:+$('webThrottle').value,aileron:+$('webAileron').value,elevator:+$('webElevator').value,rudder:+$('webRudder').value};
  if(state.mode==='demo'){logEvent('WEB CMD',`T ${payload.throttle}% / A ${payload.aileron}% / E ${payload.elevator}% / R ${payload.rudder}%`,'DEMO');toast('Demo command accepted');return;}
  try{const r=await fetch(`${state.endpoint.replace(/\/$/,'')}/api/control`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(!r.ok)throw new Error();logEvent('WEB CMD','Remote control command sent','SENT');toast('Command sent to NodeMCU')}catch(e){logEvent('WEB CMD','Remote command failed','ERROR');toast('Command failed — check endpoint/CORS/HTTPS')}
});
$('clearLogs').addEventListener('click',()=>{state.logs=[];renderLogs();toast('Event log cleared')});
$('saveSettings').addEventListener('click',()=>{
  state.mode=$('connectionMode').value;state.endpoint=$('endpointInput').value.trim();state.pollMs=Math.max(100,+$('pollInput').value||500);
  localStorage.setItem('fdv1-settings',JSON.stringify({mode:state.mode,endpoint:state.endpoint,pollMs:state.pollMs}));
  setText('transportText',state.mode==='demo'?'DEMO LINK':'CONNECTING');setText('webHealth',state.mode==='demo'?'DEMO':'CONNECTING');
  logEvent('CONFIG',`Connection mode set to ${state.mode.toUpperCase()}`,'SAVED');restartPoll();toast('Connection settings saved');
});

function restartPoll(){clearInterval(restartPoll.timer);restartPoll.timer=setInterval(()=>state.mode==='demo'?simulate():pollLive(),state.mode==='demo'?100:state.pollMs)}
function updateClock(){const d=new Date();setText('clock',`${d.toUTCString().slice(17,25)} UTC`);const sec=Math.floor((Date.now()-state.started)/1000);setText('sideUptime',`${String(Math.floor(sec/3600)).padStart(2,'0')}:${String(Math.floor(sec%3600/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`)}

try{const s=JSON.parse(localStorage.getItem('fdv1-settings'));if(s){Object.assign(state,s);$('connectionMode').value=state.mode;$('endpointInput').value=state.endpoint;$('pollInput').value=state.pollMs}}catch(e){}
wireNav();logEvent('SYSTEM','Flight Deck V1 initialized','READY');logEvent('LINK','RC telemetry pipeline standing by','NOMINAL');render();restartPoll();setInterval(updateClock,1000);updateClock();