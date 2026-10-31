import { Component, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Clone, Sky, useGLTF, useProgress } from '@react-three/drei';
import * as THREE from 'three';
import { ArrowLeft, Crosshair, RotateCcw, Volume2, VolumeX } from 'lucide-react';

const SOLDIER_URL = 'https://s3.thr3.sotoon.ir/app-builder/models/daf5de38902e458aa57ff5ba9460ca02-t1024.glb';
const RIFLE_URL = 'https://s3.thr3.sotoon.ir/app-builder/models/92a2efa3086b4eec8ee93b910ce77aa1-t1024.glb';
const CRATE_URL = 'https://s3.thr3.sotoon.ir/app-builder/models/2a3ac54357bb4b92bfbc119111c09fd1-t1024.glb';
const HALF = 18;
const CRATES: [number, number][] = [[-7,-6],[7,-6],[-7,6],[7,6],[0,0],[0,-10],[0,10]];
const SPAWNS: [number,number][] = [[-11,-11],[11,-11],[-11,10],[11,10],[0,12]];

export type Fighter = { id: string; name: string; x: number; z: number; yaw: number; health: number; kills: number };
export type GameEvent = { type: string; id: string; name?: string; x?: number; z?: number; yaw?: number; target?: string; health?: number };
type Props = { mode: 'solo' | 'room'; roomCode?: string; spawnZ?: number; playerId: string; playerName: string; peers: Fighter[]; onMove: (x: number,z: number,yaw: number) => void; onHit: (target: string) => void; onExit: () => void; onRespawn: () => void; health: number; kills: number; deaths: number };

class SceneBoundary extends Component<{children: ReactNode},{failed:boolean}> {
  state = { failed:false };
  static getDerivedStateFromError() { return { failed:true }; }
  componentDidCatch(error: Error) { console.error('3D scene failed:', error); }
  render() { return this.state.failed ? <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-[#101820] text-white"><p>بارگذاری صحنه ممکن نشد.</p><button data-testid="retry-scene" className="border border-white/30 px-5 py-2" onClick={() => this.setState({failed:false})}>تلاش دوباره</button></div> : this.props.children; }
}

function ProgressOverlay() {
  const { active, progress } = useProgress();
  const [ready, setReady] = useState(false);
  useEffect(() => { if (active) setReady(false); else { const t = setTimeout(() => setReady(true), 450); return () => clearTimeout(t); } }, [active]);
  if (ready) return null;
  return <div data-testid="scene-loading" className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#101820] text-white"><Crosshair size={44} className="mb-5 text-[#1a9fff] animate-pulse"/><div className="text-xl font-black">در حال آماده‌سازی میدان نبرد</div><div className="mt-5 h-1 w-48 bg-white/15"><div className="h-full bg-[#1a9fff] transition-all" style={{width:`${Math.max(5,progress)}%`}}/></div><span className="mt-3 font-mono text-sm text-white/50" dir="ltr">{Math.round(progress)}%</span></div>;
}

function makeTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#60656a'; ctx.fillRect(0,0,256,256);
  let seed = 47; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for(let i=0;i<2700;i++){ const v = Math.floor(70+rnd()*75); ctx.fillStyle=`rgba(${v},${v},${v},${rnd()*.16})`; ctx.fillRect(rnd()*256,rnd()*256,rnd()*4+1,rnd()*4+1); }
  ctx.strokeStyle='rgba(26,32,39,.3)'; ctx.lineWidth=2;
  for(let i=0;i<256;i+=64){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,256);ctx.moveTo(0,i);ctx.lineTo(256,i);ctx.stroke();}
  const t = new THREE.CanvasTexture(c); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(8,8); t.colorSpace=THREE.SRGBColorSpace; return t;
}

function Soldier({x,z,yaw=0,tint='#d2dee7'}:{x:number;z:number;yaw?:number;tint?:string}) {
  const {scene} = useGLTF(SOLDIER_URL);
  return <group position={[x,0,z]} rotation={[0,yaw,0]}><Clone object={scene} scale={0.0005124} castShadow /><mesh position={[0,1.95,0]}><sphereGeometry args={[0.09,8,8]}/><meshBasicMaterial color={tint}/></mesh></group>;
}
function Crate({x,z}:{x:number;z:number}) { const {scene}=useGLTF(CRATE_URL); return <group position={[x,0,z]}><Clone object={scene} scale={1.273} castShadow receiveShadow /></group>; }
function HeldRifle({recoil}:{recoil:number}) {
  const {scene}=useGLTF(RIFLE_URL);
  return <group position={[0.31,-0.27,-0.53+recoil*.08]} rotation={[0,-0.1,0.05+recoil*.05]}><Clone object={scene} scale={0.09070}/></group>;
}
function PlayerCamera({moveRef,lookRef,fireRef,peers,onMove,onHit,onSoloHit,alive,spawnZ}:{moveRef:React.RefObject<{x:number;y:number}>;lookRef:React.RefObject<{dx:number;dy:number}>;fireRef:React.RefObject<number>;peers:Fighter[];onMove:(x:number,z:number,yaw:number)=>void;onHit:(id:string)=>void;onSoloHit:(id:string)=>void;alive:boolean;spawnZ:number}) {
  const {camera}=useThree();
  const pos=useRef(new THREE.Vector3(0,1.65,spawnZ)); const yaw=useRef(spawnZ<0?Math.PI:0); const pitch=useRef(0); const lastFire=useRef(0); const lastSync=useRef(0);
  const worldTarget=useMemo(()=>new THREE.Vector3(),[]); const direction=useMemo(()=>new THREE.Vector3(),[]);
  useFrame((state,delta)=>{
    const dt=Math.min(delta,.05);
    const look=lookRef.current; yaw.current-=look.dx*.003; pitch.current=THREE.MathUtils.clamp(pitch.current-look.dy*.003,-1.12,1.12); look.dx=0;look.dy=0;
    const move=moveRef.current;
    if(alive){
      const speed=6.2*dt; const nx=pos.current.x+(Math.cos(yaw.current)*move.x+Math.sin(yaw.current)*move.y)*speed; const nz=pos.current.z+(Math.sin(yaw.current)*move.x-Math.cos(yaw.current)*move.y)*speed;
      const blocked=(x:number,z:number)=>CRATES.some(([cx,cz])=>Math.abs(x-cx)<1.1&&Math.abs(z-cz)<1.1) || (Math.abs(x)<4.4&&Math.abs(z)<4.4);
      if(Math.abs(nx)<HALF-1.1&&!blocked(nx,pos.current.z)) pos.current.x=nx;
      if(Math.abs(nz)<HALF-1.1&&!blocked(pos.current.x,nz)) pos.current.z=nz;
    }
    pos.current.y=1.65+(alive&&Math.abs(move.x)+Math.abs(move.y)>.1?Math.sin(state.clock.elapsedTime*12)*.025:0);
    camera.position.copy(pos.current); camera.rotation.order='YXZ'; camera.rotation.y=yaw.current; camera.rotation.x=pitch.current;
    if(state.clock.elapsedTime-lastSync.current>.12){lastSync.current=state.clock.elapsedTime;onMove(pos.current.x,pos.current.z,yaw.current);}
    if(fireRef.current!==lastFire.current){
      lastFire.current=fireRef.current;
      if(alive){
        direction.set(0,0,-1).applyEuler(camera.rotation);
        let nearest=30; let hit:string|null=null;
        for(const p of peers){ if(p.health<=0) continue; worldTarget.set(p.x,1.15,p.z).sub(camera.position); const distance=worldTarget.length(); const dot=worldTarget.normalize().dot(direction); if(distance<nearest&&dot>Math.cos(Math.atan2(.58,distance))){nearest=distance;hit=p.id;} }
        if(hit){if(hit.startsWith('bot-'))onSoloHit(hit);else onHit(hit);}
      }
    }
  });
  return null;
}
function World({props,moveRef,lookRef,fireRef,bots,onSoloHit,recoil}:{props:Props;moveRef:React.RefObject<{x:number;y:number}>;lookRef:React.RefObject<{dx:number;dy:number}>;fireRef:React.RefObject<number>;bots:Fighter[];onSoloHit:(id:string)=>void;recoil:number}) {
  const texture=useMemo(makeTexture,[]);
  useEffect(()=>()=>texture.dispose(),[texture]);
  const targets=props.mode==='solo'?bots:props.peers;
  return <>
    <color attach="background" args={['#8597a5']}/><fog attach="fog" args={['#8597a5',22,62]}/><Sky sunPosition={[12,8,-18]} turbidity={9} rayleigh={.75}/>
    <hemisphereLight args={['#d3e7fa','#464444',1.45]}/><ambientLight intensity={.25}/>
    <directionalLight position={[-10,19,8]} intensity={2.3} castShadow shadow-mapSize={[1024,1024]} shadow-camera-left={-23} shadow-camera-right={23} shadow-camera-top={23} shadow-camera-bottom={-23} shadow-camera-near={1} shadow-camera-far={55}/>
    <mesh rotation={[-Math.PI/2,0,0]} receiveShadow><planeGeometry args={[HALF*2,HALF*2]}/><meshStandardMaterial map={texture} roughness={.97}/></mesh>
    {([-1,1] as const).map(side=><group key={side}><mesh position={[side*HALF,2,0]} castShadow receiveShadow><boxGeometry args={[.7,4,HALF*2+1]}/><meshStandardMaterial color="#747d83" roughness={.94}/></mesh><mesh position={[0,2,side*HALF]} castShadow receiveShadow><boxGeometry args={[HALF*2+1,4,.7]}/><meshStandardMaterial color="#747d83" roughness={.94}/></mesh></group>)}
    <mesh position={[0,2.2,0]} castShadow receiveShadow><boxGeometry args={[8,4.4,8]}/><meshStandardMaterial color="#879095" map={texture} roughness={.95}/></mesh>
    {[[-12,0],[12,0],[0,-15],[0,15]].map(([x,z],i)=><mesh key={i} position={[x,1.4,z]} castShadow receiveShadow><boxGeometry args={i<2?[2,2.8,5]:[5,2.8,2]}/><meshStandardMaterial color="#727c83" map={texture} roughness={.95}/></mesh>)}
    {CRATES.map(([x,z],i)=><Crate key={i} x={x} z={z}/>)}
    {targets.filter(p=>p.health>0).map(p=><Soldier key={p.id} x={p.x} z={p.z} yaw={p.yaw} tint={p.id.startsWith('bot')?'#ee8f6f':'#65bfff'}/>)}
    <PlayerCamera moveRef={moveRef} lookRef={lookRef} fireRef={fireRef} peers={targets} onMove={props.onMove} onHit={props.onHit} onSoloHit={onSoloHit} alive={props.health>0} spawnZ={props.spawnZ??-13}/>
    <group position={[0,0,0]}><WeaponView recoil={recoil}/></group>
  </>;
}
function WeaponView({recoil}:{recoil:number}) {const {camera}=useThree();const ref=useRef<THREE.Group>(null);useFrame(()=>{if(ref.current){ref.current.position.copy(camera.position);ref.current.quaternion.copy(camera.quaternion);}});return <group ref={ref}><HeldRifle recoil={recoil}/></group>;}

export default function Game(props:Props) {
  const moveRef=useRef({x:0,y:0}); const lookRef=useRef({dx:0,dy:0}); const fireRef=useRef(0);
  const joyStart=useRef<{x:number;y:number}|null>(null); const lookStart=useRef<{x:number;y:number}|null>(null);
  const [joy,setJoy]=useState({x:0,y:0}); const [ammo,setAmmo]=useState(30); const [reloading,setReloading]=useState(false);
  const [recoil,setRecoil]=useState(0); const [muted,setMuted]=useState(true); const [soloKills,setSoloKills]=useState(0); const [soloHealth,setSoloHealth]=useState(100);
  const [bots,setBots]=useState<Fighter[]>(()=>SPAWNS.map(([x,z],i)=>({id:`bot-${i}`,name:`نگهبان ${i+1}`,x,z,yaw:Math.PI,health:100,kills:0})));
  const eliminatedBots=useRef(new Set<string>());
  const [visible,setVisible]=useState(!document.hidden); const [orientation,setOrientation]=useState(window.innerWidth>window.innerHeight);
  useEffect(()=>{const fn=()=>setVisible(!document.hidden);const orient=()=>setOrientation(window.innerWidth>window.innerHeight);document.addEventListener('visibilitychange',fn);window.addEventListener('resize',orient);return()=>{document.removeEventListener('visibilitychange',fn);window.removeEventListener('resize',orient);};},[]);
  useEffect(()=>{if(props.mode!=='solo'||soloHealth<=0||!visible)return;const timer=setInterval(()=>{setSoloHealth(h=>Math.max(0,h-2));},1600);return()=>clearInterval(timer);},[props.mode,soloHealth,visible]);
  useEffect(()=>{if(recoil===0)return;const timer=setTimeout(()=>setRecoil(0),110);return()=>clearTimeout(timer);},[recoil]);
  const onSoloHit=(id:string)=>{const bot=bots.find(b=>b.id===id);if(!bot||bot.health<=0||eliminatedBots.current.has(id))return;const nextHealth=Math.max(0,bot.health-34);setBots(prev=>prev.map(b=>b.id===id?{...b,health:Math.max(0,b.health-34)}:b));if(nextHealth===0){eliminatedBots.current.add(id);setSoloKills(k=>k+1);setTimeout(()=>{eliminatedBots.current.delete(id);setBots(current=>current.map(b=>b.id===id?{...b,health:100}:b));},4000);}};
  const reload=()=>{if(reloading||ammo===30)return;setReloading(true);setTimeout(()=>{setAmmo(30);setReloading(false);},1400);};
  const fire=()=>{if(reloading||ammo<=0||(props.mode==='solo'?soloHealth:props.health)<=0)return;setAmmo(a=>a-1);setRecoil(1);fireRef.current++;if(!muted){try{const context=new AudioContext();const oscillator=context.createOscillator();const gain=context.createGain();oscillator.type='sawtooth';oscillator.frequency.setValueAtTime(140,context.currentTime);oscillator.frequency.exponentialRampToValueAtTime(38,context.currentTime+.08);gain.gain.setValueAtTime(.08,context.currentTime);gain.gain.exponentialRampToValueAtTime(.001,context.currentTime+.09);oscillator.connect(gain).connect(context.destination);oscillator.start();oscillator.stop(context.currentTime+.09);oscillator.onended=()=>context.close();}catch{/* audio is optional */}}};
  const health=props.mode==='solo'?soloHealth:props.health;const kills=props.mode==='solo'?soloKills:props.kills;
  const reset=()=>{if(props.mode==='solo'){setSoloHealth(100);setAmmo(30);eliminatedBots.current.clear();setBots(SPAWNS.map(([x,z],i)=>({id:`bot-${i}`,name:`نگهبان ${i+1}`,x,z,yaw:Math.PI,health:100,kills:0})));}else props.onRespawn();};
  return <div data-testid="game-screen" className="relative h-dvh w-full overflow-hidden bg-[#101820] select-none touch-none text-white" dir="rtl">
    <SceneBoundary><Canvas shadows dpr={[1,2]} frameloop={visible?'always':'never'} camera={{fov:74,near:.08,far:90,position:[0,1.65,props.spawnZ??-13]}}><Suspense fallback={null}><World props={props} moveRef={moveRef} lookRef={lookRef} fireRef={fireRef} bots={bots} onSoloHit={onSoloHit} recoil={recoil}/></Suspense></Canvas></SceneBoundary>
    <ProgressOverlay/>
    <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#071019]/75 via-transparent to-[#071019]/65"/>
    <div className="absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 px-4 pt-[max(12px,env(safe-area-inset-top))] sm:px-6">
      <div className="flex items-center gap-2"><button data-testid="exit-game" onClick={props.onExit} className="flex h-11 w-11 items-center justify-center border border-white/20 bg-[#101820]/75 backdrop-blur hover:bg-[#3281ac] focus:outline-none focus:ring-2 focus:ring-[#1a9fff]" aria-label="بازگشت"><ArrowLeft size={20}/></button><div className="border border-white/15 bg-[#101820]/75 px-3 py-1.5 backdrop-blur"><div className="text-[11px] text-white/50">{props.mode==='room'?'اتاق بازی':'تمرین انفرادی'}</div><div className="font-mono text-sm font-bold" dir="ltr">{props.mode==='room'?props.roomCode:'SOLO MATCH'}</div></div></div>
      <div className="flex gap-2"><div data-testid="kill-count" className="border border-white/15 bg-[#101820]/75 px-4 py-2 text-center backdrop-blur"><div className="text-[11px] text-white/50">حذف</div><div className="font-mono text-lg font-black">{kills}</div></div><div className="border border-white/15 bg-[#101820]/75 px-4 py-2 text-center backdrop-blur"><div className="text-[11px] text-white/50">{props.mode==='room'?'بازیکن':'هدف'}</div><div className="font-mono text-lg font-black">{props.mode==='room'?props.peers.filter(p=>p.health>0).length+1:bots.filter(b=>b.health>0).length}</div></div><button data-testid="toggle-sound" onClick={()=>setMuted(v=>!v)} className="flex h-11 w-11 items-center justify-center border border-white/15 bg-[#101820]/75 hover:bg-[#3281ac]" aria-label="صدا">{muted?<VolumeX size={18}/>:<Volume2 size={18}/>}</button></div>
    </div>
    <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 text-white/85"><Crosshair size={28} strokeWidth={1.4}/></div>
    <div className="absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-2 px-4 pb-[max(14px,env(safe-area-inset-bottom))] sm:px-7">
      <div className="flex flex-col items-start gap-2"><div className="border-s-2 border-[#1a9fff] bg-[#101820]/70 px-3 py-1 text-xs text-white/70">حرکت</div><div data-testid="movement-joystick" onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);joyStart.current={x:e.clientX,y:e.clientY};}} onPointerMove={e=>{if(!joyStart.current)return;const x=THREE.MathUtils.clamp((e.clientX-joyStart.current.x)/45,-1,1),y=THREE.MathUtils.clamp((joyStart.current.y-e.clientY)/45,-1,1);moveRef.current={x,y};setJoy({x,y});}} onPointerUp={()=>{joyStart.current=null;moveRef.current={x:0,y:0};setJoy({x:0,y:0});}} onPointerCancel={()=>{joyStart.current=null;moveRef.current={x:0,y:0};setJoy({x:0,y:0});}} className="relative flex h-24 w-24 items-center justify-center rounded-full border border-white/35 bg-[#101820]/55 sm:h-32 sm:w-32"><div className="absolute h-11 w-11 rounded-full border border-[#1a9fff]/80 bg-[#3281ac]/60 shadow-[0_0_20px_#1a9fff55]" style={{transform:`translate(${joy.x*27}px,${-joy.y*27}px)`}}/></div></div>
      <div className="mb-2 flex flex-col items-center gap-1.5"><div data-testid="health-value" className="flex items-center gap-2 bg-[#101820]/75 px-3 py-1 font-mono text-xl font-black"><span className="text-xs font-normal text-white/60">جان</span><span className={health<30?'text-red-400':''}>{health}</span></div><div className="h-1.5 w-20 bg-white/25"><div className="h-full bg-[#1a9fff] transition-all" style={{width:`${health}%`}}/></div></div>
      <div className="flex items-end gap-2"><div className="flex flex-col gap-2"><div data-testid="ammo-value" className="bg-[#101820]/75 px-2 py-1 text-center font-mono text-lg font-black" dir="ltr">{ammo} / 30</div><button data-testid="reload-button" onClick={reload} className="flex h-12 w-12 items-center justify-center border border-white/25 bg-[#101820]/75 hover:bg-[#3281ac]" aria-label="خشاب‌گذاری"><RotateCcw size={19} className={reloading?'animate-spin':''}/></button></div><button data-testid="fire-button" onPointerDown={e=>{e.preventDefault();fire();}} className="flex h-20 w-20 items-center justify-center rounded-full border-2 border-[#1a9fff] bg-[#3281ac]/75 shadow-[0_0_25px_#1a9fff55] active:scale-95 sm:h-24 sm:w-24" aria-label="شلیک"><Crosshair size={32}/></button></div>
    </div>
    <div data-testid="look-area" className="absolute right-0 top-[20%] z-[5] h-[42%] w-[48%]" onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);lookStart.current={x:e.clientX,y:e.clientY};}} onPointerMove={e=>{if(!lookStart.current)return;lookRef.current.dx+=e.clientX-lookStart.current.x;lookRef.current.dy+=e.clientY-lookStart.current.y;lookStart.current={x:e.clientX,y:e.clientY};}} onPointerUp={()=>lookStart.current=null} onPointerCancel={()=>lookStart.current=null}/>
    {health===0&&<div data-testid="respawn-overlay" className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-[#09131d]/90 text-center"><div className="mb-2 text-sm tracking-widest text-[#1a9fff]">پایان این دور</div><h2 className="mb-6 text-3xl font-black">از میدان خارج شدی</h2><button data-testid="respawn-button" onClick={reset} className="bg-[#3281ac] px-8 py-3 font-bold hover:bg-[#1a9fff]">شروع دوباره</button></div>}
    {!orientation&&<div data-testid="rotate-hint" className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-[#101820] px-8 text-center"><span className="text-5xl">↻</span><h2 className="text-2xl font-black">گوشی را افقی بگیرید</h2><p className="text-sm text-white/60">برای تجربهٔ بهتر بازی را در حالت افقی اجرا کنید.</p><button data-testid="rotate-exit" onClick={props.onExit} className="mt-4 border border-white/25 px-5 py-2">بازگشت به منو</button></div>}
  </div>;
}
