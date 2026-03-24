'use strict';

// ─── Canvas & scale ───────────────────────────────────────────
const canvas = document.getElementById('c');
const ctx    = canvas.getContext('2d');

const LW = 600, LH = 400;            // logical dimensions
let scale = 1;

function resize() {
  const vw = window.innerWidth - 4;
  const vh = window.innerHeight - 80;
  if (vw / vh > LW / LH) {
    canvas.height = Math.min(vh, 440);
    canvas.width  = canvas.height * (LW / LH);
  } else {
    canvas.width  = Math.min(vw, 560);
    canvas.height = canvas.width * (LH / LW);
  }
  scale = canvas.width / LW;
}
resize();
window.addEventListener('resize', resize);

// ─── Pitch geometry ───────────────────────────────────────────
const PL=44, PR=556, PT=32, PB=368;   // pitch rect
const GY1=155, GY2=245;               // goal mouth
const GD=20;                          // goal depth
const P_R=13, B_R=7;                  // radii

// ─── Physics constants ────────────────────────────────────────
const FRICTION     = 0.986;
const P_FRICTION   = 0.80;
const SPIN_DECAY   = 0.955;
const MAGNUS       = 0.018;           // curl strength
const P_SPEED      = 4.0;
const GK_SPEED     = 3.3;
const MAX_KICK     = 15;
const AI_KICK      = 11;
const COOLDOWN     = 0.35;            // s after kick before re-grab

// ─── State ────────────────────────────────────────────────────
let state = 'menu';   // menu | kickoff | playing | goal | ended
let scoreP = 0, scoreCPU = 0;
let gameTime = 120;
let goalMsg = '', goalFlashT = 0;
let lastTS  = 0;
let kickoffTeam = 'p';

// ─── Entities ─────────────────────────────────────────────────
let ball, pTeam, cTeam;
let selPlayer = null;

// ─── Touch state ──────────────────────────────────────────────
let ptr = { down:false, sx:0, sy:0, cx:0, cy:0, aimMode:false };

// ─── Audio (simple Web Audio beeps) ───────────────────────────
const AC = window.AudioContext || window.webkitAudioContext;
let ac;
function ensureAudio() { if (!ac) ac = new AC(); }
function beep(freq=440, dur=0.07, vol=0.3, type='square') {
  if (!ac) return;
  try {
    const g = ac.createGain(); g.gain.setValueAtTime(vol, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
    const o = ac.createOscillator(); o.type = type; o.frequency.value = freq;
    o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + dur);
  } catch(e){}
}
function goalSound() {
  if (!ac) return;
  [523,659,784,1047].forEach((f,i) => {
    setTimeout(()=>beep(f,0.18,0.4,'sine'), i*120);
  });
}

// ─── Helpers ──────────────────────────────────────────────────
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function clamp(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); }
function rand(lo,hi){ return lo + Math.random()*(hi-lo); }

function mkPlayer(x,y,team,isGK,num){
  return {x,y,vx:0,vy:0,team,isGK,num,cd:0};
}

// ─── INIT ─────────────────────────────────────────────────────
function initGame(){
  scoreP=0; scoreCPU=0; gameTime=120; kickoffTeam='p';
  updateHUD();
  setupKickoff();
}

function setupKickoff(){
  ball = {x:LW/2, y:LH/2, vx:0, vy:0, spin:0, owner:null};
  ptr.aimMode = false;

  // Player team (blue) — attacks RIGHT goal (PR)
  pTeam = [
    mkPlayer(66,     LH/2,    'p', true,  1),   // GK
    mkPlayer(155,    LH/2-62, 'p', false, 3),   // DEF
    mkPlayer(155,    LH/2+62, 'p', false, 5),   // DEF
    mkPlayer(265,    LH/2,    'p', false, 8),   // MID
    mkPlayer(LW/2-18,LH/2,   'p', false, 9),   // FWD (kickoff)
  ];
  // CPU team (red) — attacks LEFT goal (PL)
  cTeam = [
    mkPlayer(LW-66,    LH/2,    'cpu', true,  1),
    mkPlayer(LW-155,   LH/2-62, 'cpu', false, 3),
    mkPlayer(LW-155,   LH/2+62, 'cpu', false, 5),
    mkPlayer(LW-265,   LH/2,    'cpu', false, 8),
    mkPlayer(LW/2+22,  LH/2+6,  'cpu', false, 9),
  ];

  selPlayer = pTeam[4];
  state = 'kickoff';
}

// ─── PHYSICS ──────────────────────────────────────────────────
function updateBall(){
  if (ball.owner) {
    // Stick ball just in front of carrier
    const p = ball.owner;
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > 0.2) {
      ball.x = p.x + (p.vx/sp)*(P_R+B_R-1);
      ball.y = p.y + (p.vy/sp)*(P_R+B_R-1);
    } else {
      ball.x = p.x; ball.y = p.y;
    }
    return;
  }

  // Magnus / curl effect
  ball.vx += ball.spin * ball.vy * MAGNUS;
  ball.vy -= ball.spin * ball.vx * MAGNUS;
  ball.vx *= FRICTION;
  ball.vy *= FRICTION;
  ball.spin *= SPIN_DECAY;
  ball.x += ball.vx;
  ball.y += ball.vy;

  // Wall collisions — check goals first
  if (ball.x - B_R < PL) {
    if (ball.y > GY1 && ball.y < GY2) { triggerGoal('cpu'); return; }
    ball.x = PL + B_R; ball.vx = Math.abs(ball.vx)*0.55; ball.spin *= -0.4;
    beep(180, 0.06, 0.25);
  }
  if (ball.x + B_R > PR) {
    if (ball.y > GY1 && ball.y < GY2) { triggerGoal('p'); return; }
    ball.x = PR - B_R; ball.vx = -Math.abs(ball.vx)*0.55; ball.spin *= -0.4;
    beep(180, 0.06, 0.25);
  }
  if (ball.y - B_R < PT){ ball.y = PT+B_R; ball.vy = Math.abs(ball.vy)*0.55; beep(200,0.05,0.2); }
  if (ball.y + B_R > PB){ ball.y = PB-B_R; ball.vy = -Math.abs(ball.vy)*0.55; beep(200,0.05,0.2); }
}

function updatePlayers(dt){
  const all = [...pTeam, ...cTeam];
  all.forEach(p => {
    p.vx *= P_FRICTION; p.vy *= P_FRICTION;
    p.x += p.vx; p.y += p.vy;
    p.x = clamp(p.x, PL+P_R, PR-P_R);
    p.y = clamp(p.y, PT+P_R, PB-P_R);
    if (p.cd > 0) p.cd -= dt;

    // Auto pick up loose ball
    if (!ball.owner && p.cd <= 0 && dist(p,ball) < P_R+B_R+2) {
      ball.owner = p;
      ball.vx = 0; ball.vy = 0; ball.spin = 0;
    }
  });

  // Player-player collisions (simple push)
  for (let i=0; i<all.length; i++) {
    for (let j=i+1; j<all.length; j++) {
      const a=all[i], b=all[j];
      const d = dist(a,b);
      if (d < P_R*1.9 && d > 0.1) {
        const nx=(b.x-a.x)/d, ny=(b.y-a.y)/d;
        const overlap = P_R*1.9 - d;
        a.x -= nx*overlap*0.4; a.y -= ny*overlap*0.4;
        b.x += nx*overlap*0.4; b.y += ny*overlap*0.4;
      }
    }
  }
}

function kick(p, tx, ty, power, spin){
  if (ball.owner !== p) return;
  const dx=tx-p.x, dy=ty-p.y, d=Math.hypot(dx,dy);
  if (d < 0.1) return;
  ball.owner = null;
  ball.vx = (dx/d)*power;
  ball.vy = (dy/d)*power;
  ball.spin = spin;
  p.cd = COOLDOWN;
  beep(300+power*20, 0.08, 0.3, 'triangle');
}

function triggerGoal(team){
  if (state !== 'playing') return;
  if (team === 'p') scoreP++; else scoreCPU++;
  goalMsg = team === 'p' ? '⚽  GOAL!  YOU SCORE!' : '😱  CPU SCORES!';
  goalFlashT = 2.6;
  state = 'goal';
  updateHUD();
  goalSound();
  setTimeout(()=>{
    kickoffTeam = team === 'p' ? 'cpu' : 'p';
    setupKickoff();
    if (gameTime <= 0) { endGame(); return; }
    state = 'playing';
  }, 2600);
}

function endGame(){
  state = 'ended';
  const ol = document.getElementById('overlay');
  ol.querySelector('h1').textContent =
    scoreP > scoreCPU ? '🏆 YOU WIN!' :
    scoreP < scoreCPU ? '😢 CPU WINS' : '🤝 DRAW!';
  ol.querySelectorAll('.inst')[0].textContent = `Final: ${scoreP} – ${scoreCPU}`;
  ol.querySelectorAll('.inst')[1].textContent = '';
  ol.querySelectorAll('.inst')[2].textContent = '';
  ol.querySelectorAll('.inst')[3].textContent = '';
  document.getElementById('startBtn').textContent = 'PLAY AGAIN';
  ol.style.display = 'flex';
}

// ─── AUTO-SELECT ───────────────────────────────────────────────
function autoSelect(){
  if (ptr.aimMode) return; // don't change while aiming
  // If someone on pTeam owns ball, select them
  const owner = pTeam.find(p => p === ball.owner);
  if (owner) { selPlayer = owner; return; }
  // Otherwise pick pTeam player closest to ball
  let best=null, bestD=Infinity;
  pTeam.forEach(p => { const d=dist(p,ball); if(d<bestD){bestD=d;best=p;} });
  selPlayer = best;
}

// ─── AI ───────────────────────────────────────────────────────
let aiTimer = 0;

function updateAI(dt){
  aiTimer -= dt;

  // GK
  const gk = cTeam[0];
  aiGK(gk, dt);

  // Find outfield CPU player closest to ball
  let closest=null, closestD=Infinity;
  cTeam.slice(1).forEach(p => {
    const d = dist(p, ball);
    if (d < closestD) { closestD=d; closest=p; }
  });

  cTeam.slice(1).forEach((p,i) => {
    if (p === closest) {
      aiChase(p);
    } else {
      aiShape(p, i);
    }
  });
}

function aiGK(gk, dt){
  const tx = LW - 72;
  const ty = clamp(ball.y, GY1+18, GY2-18);
  moveTo(gk, tx, ty, GK_SPEED);

  // Rush out if ball very close to goal
  if (ball.x > LW-160 && Math.abs(ball.y - gk.y) < 55) {
    moveTo(gk, ball.x, ball.y, GK_SPEED*1.4);
  }
  if (ball.owner === gk) {
    // Hoof upfield
    const fwd = cTeam.find(p => !p.isGK);
    const tx2 = fwd ? fwd.x + rand(-25,25) : LW/2;
    const ty2 = fwd ? fwd.y + rand(-20,20) : LH/2;
    kick(gk, tx2, ty2, rand(8,11), 0);
  }
}

function aiChase(p){
  if (ball.owner === p) {
    // Shoot if close enough to player goal (PL)
    if (p.x < LW*0.52 || dist(p,{x:PL,y:LH/2}) < 200) {
      const aimY = LH/2 + rand(-30,30);
      const spinAmt = (rand(0,1)>0.5 ? 1 : -1) * rand(0.4, 1.1);
      kick(p, PL-10, aimY, rand(9, AI_KICK), spinAmt);
    } else {
      // Dribble toward goal
      moveTo(p, p.x - 120, p.y + rand(-8,8), P_SPEED);
    }
  } else {
    moveTo(p, ball.x, ball.y, P_SPEED);
  }
}

// Positioning for off-ball CPU players
const shapePts = [
  {x:LW-210, y:LH/2-65},
  {x:LW-210, y:LH/2+65},
  {x:LW-310, y:LH/2},
];
function aiShape(p, i){
  const t = shapePts[i % shapePts.length];
  const ty = t.y + (ball.y - LH/2)*0.28;
  moveTo(p, t.x, ty, P_SPEED*0.55);
}

function moveTo(p, tx, ty, spd){
  const dx=tx-p.x, dy=ty-p.y, d=Math.hypot(dx,dy);
  if (d > 2) { p.vx=(dx/d)*spd; p.vy=(dy/d)*spd; }
}

// ─── INPUT ────────────────────────────────────────────────────
function toLx(sx){ return sx / scale; }
function toLy(sy){ return sy / scale; }

function pointerDown(lx, ly){
  if (state !== 'playing' && state !== 'kickoff') return;
  ptr.down=true; ptr.sx=lx; ptr.sy=ly; ptr.cx=lx; ptr.cy=ly;
  ptr.aimMode = false;

  // Select nearest pTeam player to tap
  let best=null, bestD=Infinity;
  pTeam.forEach(p => { const d=dist(p,{x:lx,y:ly}); if(d<bestD){bestD=d;best=p;} });
  if (best && bestD < 70) selPlayer = best;

  // Enter aim if selected player owns or is very near ball
  if (selPlayer && (ball.owner===selPlayer || dist(selPlayer,ball) < P_R+B_R+6)) {
    ptr.aimMode = true;
  }
}

function pointerMove(lx, ly){
  if (!ptr.down) return;
  ptr.cx=lx; ptr.cy=ly;
}

function pointerUp(){
  if (!ptr.down) return;
  ptr.down = false;

  if (!ptr.aimMode || !selPlayer) { ptr.aimMode=false; return; }

  const dx = ptr.cx - ptr.sx;
  const dy = ptr.cy - ptr.sy;
  const swipe = Math.hypot(dx, dy);
  if (swipe < 6) { ptr.aimMode=false; return; }

  // Force possession if close enough
  if (ball.owner !== selPlayer) {
    if (dist(selPlayer, ball) < P_R+B_R+8) {
      ball.owner = selPlayer;
      ball.vx=0; ball.vy=0; ball.spin=0;
    }
  }
  // Kickoff first touch
  if (state === 'kickoff') {
    ball.owner = selPlayer;
    state = 'playing';
  }

  if (ball.owner === selPlayer) {
    const power  = clamp(swipe/38, 0, 1) * MAX_KICK;
    const angle  = Math.atan2(dy, dx);

    // Curl: project touch-start offset onto perpendicular of kick angle
    const offX   = ptr.sx - ball.x;
    const offY   = ptr.sy - ball.y;
    const perpX  = -Math.sin(angle);
    const perpY  =  Math.cos(angle);
    const lateral = offX*perpX + offY*perpY;
    const spin   = lateral * 0.09;

    ball.owner = null;
    ball.vx = Math.cos(angle)*power;
    ball.vy = Math.sin(angle)*power;
    ball.spin = spin;
    selPlayer.cd = COOLDOWN;
    selPlayer.vx = Math.cos(angle)*1.5;
    selPlayer.vy = Math.sin(angle)*1.5;
    beep(300+power*22, 0.09, 0.35, 'triangle');
  }

  ptr.aimMode = false;
}

// Bind touch
canvas.addEventListener('touchstart', e => {
  e.preventDefault(); ensureAudio();
  const r=canvas.getBoundingClientRect(), t=e.touches[0];
  pointerDown(toLx(t.clientX-r.left), toLy(t.clientY-r.top));
},{passive:false});
canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  const r=canvas.getBoundingClientRect(), t=e.touches[0];
  pointerMove(toLx(t.clientX-r.left), toLy(t.clientY-r.top));
},{passive:false});
canvas.addEventListener('touchend', e => { e.preventDefault(); pointerUp(); },{passive:false});

// Bind mouse (desktop testing)
canvas.addEventListener('mousedown', e => {
  ensureAudio();
  const r=canvas.getBoundingClientRect();
  pointerDown(toLx(e.clientX-r.left), toLy(e.clientY-r.top));
});
canvas.addEventListener('mousemove', e => {
  const r=canvas.getBoundingClientRect();
  pointerMove(toLx(e.clientX-r.left), toLy(e.clientY-r.top));
});
canvas.addEventListener('mouseup', pointerUp);

// ─── RENDERING ────────────────────────────────────────────────
function drawPitch(){
  // Base grass
  ctx.fillStyle='#2d7a2d'; ctx.fillRect(0,0,LW,LH);
  // Stripes
  const stripeW = (PR-PL)/10;
  ctx.fillStyle='#2a722a';
  for(let i=0;i<10;i+=2) ctx.fillRect(PL+i*stripeW, PT, stripeW, PB-PT);

  ctx.strokeStyle='rgba(255,255,255,0.75)'; ctx.lineWidth=2;
  // Pitch border
  ctx.strokeRect(PL, PT, PR-PL, PB-PT);
  // Halfway
  ctx.beginPath(); ctx.moveTo(LW/2,PT); ctx.lineTo(LW/2,PB); ctx.stroke();
  // Centre circle
  ctx.beginPath(); ctx.arc(LW/2,LH/2,52,0,Math.PI*2); ctx.stroke();
  ctx.fillStyle='rgba(255,255,255,0.7)';
  ctx.beginPath(); ctx.arc(LW/2,LH/2,3,0,Math.PI*2); ctx.fill();
  // Penalty boxes
  ctx.strokeStyle='rgba(255,255,255,0.55)'; ctx.lineWidth=1.5;
  ctx.strokeRect(PL,     LH/2-72, 84, 144);
  ctx.strokeRect(PR-84,  LH/2-72, 84, 144);

  // LEFT GOAL (player defends — blue tint)
  ctx.fillStyle='rgba(60,80,200,0.25)';
  ctx.fillRect(PL-GD, GY1, GD, GY2-GY1);
  ctx.strokeStyle='#6699ff'; ctx.lineWidth=2.5;
  ctx.strokeRect(PL-GD, GY1, GD, GY2-GY1);
  // Goal post circles
  ctx.fillStyle='#aaddff';
  [[PL,GY1],[PL,GY2]].forEach(([x,y])=>{ ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2); ctx.fill(); });

  // RIGHT GOAL (cpu defends — red tint)
  ctx.fillStyle='rgba(200,60,60,0.25)';
  ctx.fillRect(PR, GY1, GD, GY2-GY1);
  ctx.strokeStyle='#ff7766'; ctx.lineWidth=2.5;
  ctx.strokeRect(PR, GY1, GD, GY2-GY1);
  ctx.fillStyle='#ffaaaa';
  [[PR,GY1],[PR,GY2]].forEach(([x,y])=>{ ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2); ctx.fill(); });

  // Labels
  ctx.font='9px monospace'; ctx.textAlign='center'; ctx.fillStyle='rgba(255,255,255,0.45)';
  ctx.fillText('YOUR GOAL', PL-GD/2, GY1-6);
  ctx.fillText('CPU GOAL',  PR+GD/2, GY1-6);
}

function drawPlayer(p){
  const isSel = (p === selPlayer && p.team === 'p');
  const hasBall = (p === ball.owner);

  // Selection glow
  if (isSel){
    ctx.beginPath(); ctx.arc(p.x,p.y,P_R+6,0,Math.PI*2);
    ctx.strokeStyle='rgba(255,255,0,0.7)'; ctx.lineWidth=2; ctx.stroke();
  }
  // Shadow
  ctx.beginPath(); ctx.arc(p.x+2,p.y+3,P_R,0,Math.PI*2);
  ctx.fillStyle='rgba(0,0,0,0.25)'; ctx.fill();

  // Body gradient
  const g = ctx.createRadialGradient(p.x-3,p.y-3,2,p.x,p.y,P_R);
  if (p.team==='p'){
    g.addColorStop(0, p.isGK ? '#99bbff':'#6688ff');
    g.addColorStop(1, p.isGK ? '#003388':'#1122cc');
  } else {
    g.addColorStop(0, p.isGK ? '#ffaa99':'#ff7777');
    g.addColorStop(1, p.isGK ? '#880011':'#cc1111');
  }
  ctx.beginPath(); ctx.arc(p.x,p.y,P_R,0,Math.PI*2);
  ctx.fillStyle=g; ctx.fill();
  ctx.strokeStyle = hasBall ? '#ffff00':'rgba(255,255,255,0.45)';
  ctx.lineWidth = hasBall ? 2.5 : 1;
  ctx.stroke();

  // Jersey number
  ctx.fillStyle='#fff'; ctx.font=`bold 9px monospace`;
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(p.isGK?'GK':p.num, p.x, p.y);
  ctx.textBaseline='alphabetic';
}

function drawBall(){
  const x=ball.x, y=ball.y;
  // Shadow
  ctx.beginPath(); ctx.arc(x+2,y+3,B_R,0,Math.PI*2);
  ctx.fillStyle='rgba(0,0,0,0.3)'; ctx.fill();
  // Ball
  ctx.beginPath(); ctx.arc(x,y,B_R,0,Math.PI*2);
  ctx.fillStyle='#ffffff'; ctx.fill();
  ctx.strokeStyle='#555'; ctx.lineWidth=1; ctx.stroke();
  // Black pentagon dots
  ctx.fillStyle='#222';
  const ang = performance.now()*0.004;
  for(let i=0;i<5;i++){
    const a = ang + i*(Math.PI*2/5);
    ctx.beginPath();
    ctx.arc(x+Math.cos(a)*3.5, y+Math.sin(a)*3.5, 1.5, 0, Math.PI*2);
    ctx.fill();
  }
}

function drawAimGuide(){
  if (!ptr.aimMode || !ptr.down || !selPlayer) return;
  const dx = ptr.cx-ptr.sx, dy = ptr.cy-ptr.sy;
  const swipe = Math.hypot(dx,dy);
  if (swipe < 5) return;

  const angle = Math.atan2(dy,dx);
  const power = clamp(swipe/38,0,1);
  const bx=ball.x, by=ball.y;

  // Aim line
  const lineLen = clamp(swipe*2.5, 30, 130);
  ctx.save();
  ctx.strokeStyle=`rgba(255,220,0,${0.5+power*0.4})`;
  ctx.lineWidth=2; ctx.setLineDash([6,5]);
  ctx.beginPath();
  ctx.moveTo(bx,by);
  ctx.lineTo(bx+Math.cos(angle)*lineLen, by+Math.sin(angle)*lineLen);
  ctx.stroke();
  ctx.setLineDash([]);

  // Compute spin
  const offX=ptr.sx-bx, offY=ptr.sy-by;
  const perpX=-Math.sin(angle), perpY=Math.cos(angle);
  const lateral = offX*perpX + offY*perpY;
  const spin = lateral*0.09;

  // Curl path preview
  if (Math.abs(spin) > 0.25){
    let px=bx, py=by;
    let pvx=Math.cos(angle)*power*9, pvy=Math.sin(angle)*power*9;
    let ps=spin;
    ctx.strokeStyle='rgba(0,255,255,0.55)';
    ctx.lineWidth=1.5; ctx.setLineDash([3,6]);
    ctx.beginPath(); ctx.moveTo(px,py);
    for(let i=0;i<25;i++){
      pvx += ps*pvy*MAGNUS; pvy -= ps*pvx*MAGNUS;
      pvx *= FRICTION; pvy *= FRICTION; ps *= SPIN_DECAY;
      px += pvx; py += pvy;
      ctx.lineTo(px,py);
    }
    ctx.stroke(); ctx.setLineDash([]);

    // Curl label
    ctx.fillStyle='#00ffff'; ctx.font='bold 11px monospace';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(spin>0?'↻ CURL':'↺ CURL', bx+Math.cos(angle)*55, by+Math.sin(angle)*55-14);
    ctx.textBaseline='alphabetic';
  }

  // Power bar
  ctx.restore();
  const barX=bx+10, barY=by-26;
  ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(barX,barY,52,8);
  ctx.fillStyle=`hsl(${(1-power)*110},100%,50%)`;
  ctx.fillRect(barX,barY,52*power,8);
  ctx.strokeStyle='#ffffff88'; ctx.lineWidth=1;
  ctx.strokeRect(barX,barY,52,8);
  ctx.fillStyle='#fff'; ctx.font='9px monospace';
  ctx.textAlign='left'; ctx.textBaseline='middle';
  ctx.fillText('PWR',barX+54,barY+4);
  ctx.textBaseline='alphabetic';
}

function drawGoalFlash(){
  if (goalFlashT <= 0) return;
  const alpha = Math.min(goalFlashT/2.6, 1)*0.6;
  ctx.fillStyle=`rgba(255,230,0,${alpha*0.18})`;
  ctx.fillRect(0,0,LW,LH);
  ctx.save();
  ctx.font='bold 36px monospace';
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.strokeStyle='#000'; ctx.lineWidth=5;
  ctx.strokeText(goalMsg, LW/2, LH/2);
  ctx.fillStyle='#ffff00';
  ctx.fillText(goalMsg, LW/2, LH/2);
  ctx.restore();
}

function drawKickoffBanner(){
  if (state !== 'kickoff') return;
  ctx.fillStyle='rgba(0,0,0,0.55)';
  ctx.fillRect(LW/2-115,LH/2-16,230,32);
  ctx.fillStyle='#ffff00'; ctx.font='bold 13px monospace';
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('SWIPE TO KICK OFF!', LW/2, LH/2);
  ctx.textBaseline='alphabetic';
}

// ─── HUD ──────────────────────────────────────────────────────
function updateHUD(){
  document.getElementById('score').textContent = `${scoreP} - ${scoreCPU}`;
  const m=Math.floor(gameTime/60), s=Math.floor(gameTime%60);
  document.getElementById('timer').textContent = `${m}:${s.toString().padStart(2,'0')}`;
}

// ─── MAIN LOOP ────────────────────────────────────────────────
function update(dt){
  if (state === 'playing' || state === 'kickoff'){
    autoSelect();

    if (state === 'playing'){
      gameTime = Math.max(0, gameTime-dt);
      if (gameTime <= 0) { endGame(); return; }
      updateHUD();
      updateAI(dt);
    }

    updatePlayers(dt);
    updateBall();

    // Nudge selected player toward ball when not aiming
    if (selPlayer && !ptr.aimMode && !ptr.down && ball.owner !== selPlayer){
      const d = dist(selPlayer, ball);
      if (d > P_R+B_R+4) moveTo(selPlayer, ball.x, ball.y, P_SPEED);
    }
  }
  if (state === 'goal') goalFlashT -= dt;
}

function render(){
  ctx.save();
  ctx.scale(scale, scale);
  drawPitch();
  [...pTeam,...cTeam].forEach(drawPlayer);
  drawBall();
  drawAimGuide();
  drawGoalFlash();
  drawKickoffBanner();
  ctx.restore();
}

let rafId;
function loop(ts){
  const dt = Math.min((ts-lastTS)/1000, 0.05);
  lastTS = ts;
  update(dt);
  render();
  rafId = requestAnimationFrame(loop);
}

// ─── START BUTTON ─────────────────────────────────────────────
document.getElementById('startBtn').addEventListener('click',()=>{
  ensureAudio();
  document.getElementById('overlay').style.display='none';
  // Restore instructions for next game-over
  const ol=document.getElementById('overlay');
  ol.querySelectorAll('.inst')[1].textContent='👆 Swipe to shoot — release to kick';
  ol.querySelectorAll('.inst')[2].textContent='🌀 Touch left/right of ball for curl!';
  ol.querySelectorAll('.inst')[3].textContent='Score most goals in 2 minutes!';
  initGame();
  if (rafId) cancelAnimationFrame(rafId);
  requestAnimationFrame(ts=>{ lastTS=ts; rafId=requestAnimationFrame(loop); });
});
