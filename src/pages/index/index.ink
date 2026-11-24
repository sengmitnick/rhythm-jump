<script def>
{
  "navigationBarTitleText": "节奏开跳",
  "description": "眼镜端体感节奏游戏。跟随空间箭头向左侧移、向右侧移或起跳，在节拍上完成动作。",
  "schema": {"data":{"type":"object","properties":{}}}
}
</script>
<script setup>
import wx from 'wx';
import { AudioContext, AudioPlayer } from 'audio';
import { Session } from '../../lib/session.js';
import { RhythmAudio } from '../../lib/audio.js';
import { TutorialVoice } from '../../lib/tutorial-voice.js';
import { renderSpatial as render } from '../../lib/spatial-render.js';
import { HeadPose } from '../../lib/head-pose.js';
import { createPerfMeter } from '../../lib/perf-meter.js';
import { FramePacer, shouldDrawFrame } from '../../lib/frame-pacing.js';
import { SERVICE_CONFIG } from '../../lib/service-config.js';
import { ResearchLog } from '../../lib/research-log.js';
import { LanResearchLog } from '../../lib/lan-research-log.js';
import { ConsoleResearchLog } from '../../lib/console-research-log.js';
import { LeaderboardClient } from '../../lib/leaderboard-client.js';
import { MenuNavigation, templeKey } from '../../lib/menu-navigation.js';

const MOTION_DIAGNOSTICS = SERVICE_CONFIG.motionDiagnostics === true;
const FRAME_START_TIMEOUT_MS = 400;
const TIMER_FRAME_INTERVAL_MS = 1000 / 45;
const DIAGNOSTIC_RAW_TRACE_INTERVAL_MS = 80;
const FRAME_STATS_WINDOW_MS = 5000;
const ORIENTATION_MAX_AGE_MS = 120;
const TUTORIAL_COMPLETE_KEY = 'rhythm-tutorial-complete-v1';
const DOUBLE_TAP_MS = 420;
const TAP_DEBOUNCE_MS = 65;
const DUPLICATE_TAP_MS = 160;
const SWIPE_QUIET_MS = 280;

export default {
  data: {},
  onLoad() {
    const timing=SERVICE_CONFIG.timing||{};
    this._audio=new RhythmAudio(AudioContext,AudioPlayer,{clock:()=>performance.now(),audioOffsetMs:timing.audioOffsetMs});
    this._tutorialVoice=new TutorialVoice();
    this._research=MOTION_DIAGNOSTICS?new ResearchLog({storage:wx,onError:e=>console.warn('[rhythm] research storage',String(e))}):null;
    this._rawTraceIntervalMs=SERVICE_CONFIG.fullMotionTrace===true?0:DIAGNOSTIC_RAW_TRACE_INTERVAL_MS;
    let tutorialComplete=false;
    try{tutorialComplete=wx.getStorageSync(TUTORIAL_COMPLETE_KEY)===true;}catch(e){console.warn('[rhythm] tutorial storage',String(e));}
    this._session=new Session({
      audio:this._audio,clock:()=>performance.now(),requireUpright:true,tutorialComplete,onTutorialComplete:()=>this._saveTutorial(),
      onTutorialRepeat:()=>this._tutorialVoice.retry(),onResult:(r,s)=>this._save(r,s),
      onTrace:MOTION_DIAGNOSTICS?e=>this._trace(e):null,
      rawTraceIntervalMs:this._rawTraceIntervalMs,
      displayOffsetMs:timing.displayOffsetMs,
    });
    this._session.courses=this._session.courses.filter(course=>course.native);
    this._menu=new MenuNavigation(this._session.courses.length);
    this._menuHead=new HeadPose();
    this._menuSensorAttempted=false;
    this._previewCourse=null;
    this._tutorialAutoPending=!tutorialComplete;this._tutorialTapAt=null;
    this._lastTapAt=-Infinity;this._lastTapSource=null;this._lastSwipeAt=-Infinity;
    this._sensors=[];
    const agentId=typeof SERVICE_CONFIG.agentId==='string'?SERVICE_CONFIG.agentId.trim():'';
    this._leaderboardClient=agentId&&typeof LeaderboardClient==='function'
      ?new LeaderboardClient({
        createOpenAPI:async()=>{const module=await import('open');return module.createOpenAPI();},
        agentId,timeoutMs:15000,
      }):null;
    this._leaderboard={status:'idle',songId:'',songTitle:'',chartVersion:0,entries:[],me:null,totalPlayers:0,message:'',revision:0};
    this._leaderboardCache=new Map();
    this._runId=null;this._scoreSubmittedFor=null;
    this._head=new HeadPose();
    this._perf=MOTION_DIAGNOSTICS?createPerfMeter():null;this._lastMode=null;
    this._headSupported=false;this._posePending=false;this._poseValid=null;
    this._visible=true;this._unloaded=false;this._resultAction=0;this._confirming=false;this._resumePending=false;
    this._usbLog=MOTION_DIAGNOSTICS?new ConsoleResearchLog({clock:()=>performance.now(),emit:line=>console.log(line)}):null;
    if(this._usbLog)console.warn('[rhythm] USB live capture ready');
    this._lanLog=MOTION_DIAGNOSTICS?new LanResearchLog({
      endpoints:SERVICE_CONFIG.logURLs||(SERVICE_CONFIG.logURL?[SERVICE_CONFIG.logURL]:[]), wx, fetch:typeof fetch==='function'?fetch:null,
      clock:()=>performance.now(),
      onError:error=>console.warn('[rhythm] LAN log retry',String(error)),
      onAck:info=>console.log('[rhythm] log acknowledged '+JSON.stringify(info)),
    }):null;
    this._frameStats = null;
    this._lastPlayingFrameAt = null;
    this._framePacer = new FramePacer();
    this._frameIntervalMs = this._framePacer.intervalMs;
    this._lastAnimationFrameAt = null;
    this._timer = null;
    this._frameWatch = null;
    this._usesAnimationFrame = false;
  },
  onReady() {
    this._ready=true;
    this._initTimer=setTimeout(()=>{
      this._initTimer=null;
      try{if(this._visible&&!this._unloaded&&!this._ctx){this._ctx=wx.createCanvasContext('rhythm');this._loop();}}
      catch(e){console.error('[rhythm] canvas init',String(e),e.stack||'');}
    },0);
  },
  onShow(){
    this._visible=true;
    if(this._ready&&!this._ctx){try{this._ctx=wx.createCanvasContext('rhythm');}catch(e){console.error('[rhythm] canvas init',String(e));}}
    if(this._ctx)this._loop();
  },
  onHide(){
    this._visible=false;this._resumePending=false;
    this._stopLoop();
    this._tutorialVoice?.stop();
    if(this._session){
      const session=this._session;
      session.generation++;
      session.interruptImu();
      if(session.mode==='calibrating'||session.tutorial)session.home();else session.pause();
    }
    this._tutorialTapAt=null;
    this._lastTapAt=-Infinity;this._lastTapSource=null;this._lastSwipeAt=-Infinity;
    this._leaveMenu();
    this._menuSensorAttempted=false;
    this._session?.trace('state',{state:'page-hidden'});this._research?.flush();
    this._lanLog?.flush();this._usbLog?.flush();
    this._audio?.stopMusic?.();this._audio?.suspend().catch(()=>{});this._stopSensors();
  },
  onUnload(){this._unloaded=true;if(this._initTimer!=null)clearTimeout(this._initTimer);this.onHide();this._session?.destroy().catch(console.error);this._ctx=null;},
  _loop(){
    if (this._timer != null) return;
    this._lastFrameKey = null;
    this._framePacer.reset();
    this._frameIntervalMs = this._framePacer.intervalMs;
    this._usesAnimationFrame = typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function';
    if (this._usesAnimationFrame) {
      this._lastAnimationFrameAt = performance.now();
      let nextFrameAt = this._lastAnimationFrameAt + this._frameIntervalMs;
      const draw = () => {
        if (!this._visible || !this._usesAnimationFrame) return;
        this._timer = requestAnimationFrame(draw);
        const now = performance.now();
        this._lastAnimationFrameAt = now;
        if (!shouldDrawFrame(now, nextFrameAt)) return;
        const interval = this._frameIntervalMs;
        nextFrameAt = Math.max(nextFrameAt + interval, now + interval / 2);
        this._frame();
      };
      this._timer = requestAnimationFrame(draw);
      this._armFrameWatch();
    } else this._startTimerLoop();
    this._frame();
  },
  _armFrameWatch(){
    if(this._frameWatch!=null)clearTimeout(this._frameWatch);
    const check=()=>{
      this._frameWatch=null;
      if(!this._visible||!this._usesAnimationFrame)return;
      const age=performance.now()-this._lastAnimationFrameAt;
      if(age>=FRAME_START_TIMEOUT_MS){
        if(this._timer!=null)cancelAnimationFrame(this._timer);
        this._timer=null;this._usesAnimationFrame=false;
        this._frame();this._startTimerLoop();
        return;
      }
      this._frameWatch=setTimeout(check,Math.max(1,FRAME_START_TIMEOUT_MS-age));
    };
    this._frameWatch=setTimeout(check,FRAME_START_TIMEOUT_MS);
  },
  _startTimerLoop(){
    this._usesAnimationFrame=false;
    this._frameIntervalMs=TIMER_FRAME_INTERVAL_MS;
    const draw=()=>{
      if(!this._visible||this._usesAnimationFrame)return;
      this._frame();
    };
    this._timer=setInterval(draw,TIMER_FRAME_INTERVAL_MS);
  },
  _stopLoop(){
    if (this._frameWatch != null) clearTimeout(this._frameWatch);
    if (this._timer != null) {
      if (this._usesAnimationFrame) cancelAnimationFrame(this._timer);
      else clearInterval(this._timer);
    }
    this._frameWatch = null;
    this._timer = null;
    this._usesAnimationFrame = false;
  },
  _frame(){
    if (!this._visible || !this._ctx) return;
    const startedAt = performance.now();
    try {
      const session = this._session;
      if(this._tutorialAutoPending&&!this._confirming&&session.mode==='home')this._showTutorialReady();
      if (this._resumePending && startedAt > this._resumeDeadline) {
        this._resumePending = false;
        session.message = '等待动作信号，单击重试';
        this._stopSensors();
      }
      const state = session.tick();
      const mode = session.mode;
      const inRound=mode==='playing'||mode==='tutorial';
      const measureFrame = MOTION_DIAGNOSTICS && inRound;
      if (mode !== this._lastMode) {
        if (this._lastMode === 'tutorial') this._tutorialVoice?.stop();
        if (mode === 'home') {
          if (this._lastMode === 'tutorial') this._stopSensors();
          this._menuHead.reset();
          this._menu.resetAim();
          this._menuSensorAttempted=false;
        } else if (this._lastMode === 'home') {
          this._leaveMenu();
        }
        if(this._usesAnimationFrame&&inRound&&this._lastMode!=='playing'&&this._lastMode!=='tutorial'){
          this._framePacer.reset();this._frameIntervalMs=this._framePacer.intervalMs;
        }
        this._lastMode = mode;
        // A pause or countdown is not a frame gap; restart the meter window.
        if (measureFrame) this._perf.reset(startedAt);
      }
      if (measureFrame) this._perf.tick(startedAt);
      if (inRound && this._posePending) {
        this._posePending = false;
        const reference=this._session.baseQuaternion;
        const calibrated=reference?this._head.setReference(reference,startedAt):this._head.calibrate(startedAt);
        if (MOTION_DIAGNOSTICS) this._traceHead('calibrate', { calibrated });
      }
      const menu = mode === 'home' ? this._updateMenu(startedAt) : null;
      const animated = inRound || mode === 'calibrating';
      const key = animated ? null : JSON.stringify([
        mode, menu?.focus, menu?.songIndex, menu?.previewPlaying,
        Math.round((menu?.previewProgress || 0) * 40), Math.round((menu?.dwellProgress || 0) * 40),
        menu?.cursor?.x, menu?.cursor?.y,
        session.message, session.saved, this._resultAction, this._leaderboard.revision,
      ]);
      if (!animated && key === this._lastFrameKey) {
        if (MOTION_DIAGNOSTICS) this._sendResearch(startedAt);
        return;
      }
      const model = session.model(state);
      if(menu)model.menu=menu;
      model.resultAction = this._resultAction;
      if(mode==='leaderboard')model.leaderboard={...this._leaderboard,songs:session.courses};
      model.leaderboardConfigured = !!this._leaderboardClient;
      model.showMotionDebug = MOTION_DIAGNOSTICS;
      model.perf = mode === 'playing' || mode === 'paused' ? (this._perf?.out ?? null) : null;
      const pose = this._head.pose(startedAt);
      this._session.sample({ pose });
      model.pose = pose;
      model.body = this._session.lastState;
      model.poseSupported = this._headSupported;
      if (MOTION_DIAGNOSTICS && pose.calibrated && this._headSupported) {
        if (this._poseValid !== null && pose.valid !== this._poseValid) {
          this._traceHead(pose.valid ? 'pose-resume' : 'pose-stale', { ageMs: Math.round(pose.ageMs || 0) });
        }
        this._poseValid = pose.valid;
      }
      const renderStartedAt = measureFrame ? performance.now() : 0;
      render(this._ctx, model);
      this._lastFrameKey = key;
      if (measureFrame) this._recordFrameTiming(startedAt, renderStartedAt, performance.now());
      if (MOTION_DIAGNOSTICS) this._sendResearch(startedAt);
      // Cadence changes only after sustained load; game time remains monotonic.
      if(this._usesAnimationFrame)this._frameIntervalMs = this._framePacer.observe(performance.now() - startedAt);
    } catch (e) {
      this._stopLoop();
      console.error('[rhythm] frame', String(e));
    }
  },
  _sendResearch(now){this._lanLog?.sendDue(now);this._usbLog?.sendDue(now);},
  _recordFrameTiming(startedAt, renderStartedAt, finishedAt){
    const renderMs = finishedAt - renderStartedAt;
    this._perf.cost(renderMs, finishedAt);
    if (!this._researchRunId) return;
    if (!this._frameStats) {
      this._frameStats = {
        startedAt, frames: 0, gapsOver60Ms: 0, maxGapMs: 0,
        totalGapMs: 0, gapCount: 0,
        totalRenderMs: 0, maxRenderMs: 0, maxUpdateMs: 0,
      };
    }
    const stats = this._frameStats;
    if (this._lastPlayingFrameAt !== null) {
      const gapMs = startedAt - this._lastPlayingFrameAt;
      stats.maxGapMs = Math.max(stats.maxGapMs, gapMs);
      stats.totalGapMs += gapMs;
      stats.gapCount++;
      if (gapMs > 60) stats.gapsOver60Ms++;
    }
    this._lastPlayingFrameAt = startedAt;
    stats.frames++;
    stats.totalRenderMs += renderMs;
    stats.maxRenderMs = Math.max(stats.maxRenderMs, renderMs);
    stats.maxUpdateMs = Math.max(stats.maxUpdateMs, renderStartedAt - startedAt);
    if (finishedAt - stats.startedAt >= FRAME_STATS_WINDOW_MS) this._flushFrameTiming();
  },
  _flushFrameTiming(){
    const stats = this._frameStats;
    this._frameStats = null;
    if (!stats?.frames) return;
    const ms = value => Math.round(value * 100) / 100;
    const windowMs = performance.now() - stats.startedAt;
    this._session.trace('frame-timing', {
      windowMs: ms(windowMs), frames: stats.frames,
      fps: ms(stats.frames / (windowMs / 1000)),
      targetFps: ms(1000 / this._frameIntervalMs), scheduler: this._usesAnimationFrame?'animation-frame':'timer',
      meanFrameCostMs: ms(this._framePacer.costMs),
      meanGapMs: stats.gapCount ? ms(stats.totalGapMs / stats.gapCount) : null,
      gapsOver60Ms: stats.gapsOver60Ms, maxGapMs: ms(stats.maxGapMs),
      meanRenderMs: ms(stats.totalRenderMs / stats.frames), maxRenderMs: ms(stats.maxRenderMs),
      maxUpdateMs: ms(stats.maxUpdateMs),
    });
  },
  _releaseSensor({sensor,read,error}){
    try{
      sensor.removeEventListener('reading',read);
      sensor.removeEventListener('error',error);
      sensor.stop();
    }catch(e){console.warn('[rhythm] sensor cleanup',String(e));}
  },
  _dropSensor(item){
    this._releaseSensor(item);
    this._sensors=this._sensors.filter(candidate=>candidate!==item);
  },
  _stopSensors(){
    for(const item of this._sensors)this._releaseSensor(item);
    this._sensors=[];
    // Clear the live camera sample. Session verifies the saved reference with fresh IMU readings.
    this._head?.reset();this._headSupported=false;this._poseValid=null;
  },
  _traceHead(event,data={}){this._session?.trace('head-pose',{event,...data});},
  _startHeadSensor(){
    if(this._sensors.some(item=>item.kind==='orientation'))return;
    let item=null;
    const fail=message=>{
      if(item)this._dropSensor(item);
      this._head.reset();this._menuHead.reset();this._headSupported=false;
      const session=this._session;
      session.interruptImu();
      if(session.mode==='calibrating'){
        session.mode='sensor-error';
        session.message='姿态传感器异常，请单击重试';
      }
      this._traceHead('sensor-unavailable',{message:String(message).slice(0,160)});
    };
    try{
      if(typeof AbsoluteOrientationSensor!=='function')return;
      const sensor=new AbsoluteOrientationSensor({frequency:60});
      const read=()=>{
        const now=performance.now();
        if(!this._head.calibrated&&this._session.baseQuaternion)this._head.setReference(this._session.baseQuaternion,now);
        if(this._head.sample(sensor.quaternion,now)){
          this._headSupported=true;
          if(this._session.mode==='home')this._menuHead.sample(sensor.quaternion,now);
        }
      };
      const error=e=>fail(e?.error||e?.message||'unknown');
      item={sensor,read,error,kind:'orientation'};
      sensor.addEventListener('reading',read);sensor.addEventListener('error',error);
      this._sensors.push(item);sensor.start();
    }catch(e){fail(e);}
  },
  _trace(event){
    if(!this._research)return;
    if (event.type === 'end' || (event.type === 'state' && event.mode !== 'playing' && event.mode !== 'tutorial')) {
      this._flushFrameTiming();
      this._lastPlayingFrameAt = null;
    }
    const arrivalMs=performance.now();
    if (event.type === 'start') {
      const {events, ...start} = event;
      const id = crypto.randomUUID();
      const meta = {...start,id,source:'imu',startedAtMs:arrivalMs,wallTimeMs:Date.now(),requestedHz:50,
        rawTraceIntervalMs:this._rawTraceIntervalMs,
        clocks:{arrivalMs:'performance.now milliseconds',clockMs:'performance.now milliseconds',elapsedMs:'game milliseconds, pause excluded',sensorTimestamp:'host-raw-unverified'},
        groundTruth:'not-labelled',accelerometerUnits:'host-raw-unverified',gyroscopeAvailable:typeof Gyroscope==='function',
        absoluteOrientationAvailable:typeof AbsoluteOrientationSensor==='function'};
      this._researchRunId = id;
      this._lanLog.start(id);
      this._usbLog.start(id);
      this._research.start(meta);
      this._recordTraceRow({...meta, arrivalMs});
      for (const chartEvent of events) this._recordTraceRow({type:'chart', arrivalMs, event:chartEvent});
      this._lanLog.flush(arrivalMs);
      this._usbLog.flush(arrivalMs);
      return;
    }
    const row = {...event, arrivalMs};
    if (event.type === 'end') {
      this._recordTraceRow(row, false);
      this._lanLog.finish();
      this._usbLog.finish();
      this._research.finish(event.reason, event.result);
      return;
    }
    this._recordTraceRow(row);
    if (event.type === 'calibration' || (event.type === 'state' && (event.mode === 'playing' || event.mode === 'tutorial'))) {
      this._research.requestFlush();
    } else if (event.type === 'state') this._research.flush();
  },
  _recordTraceRow(row, persist=true){
    this._lanLog.append(row);
    this._usbLog.append(row);
    if (persist) this._research.append(row);
  },
  _startSensors(){
    if(this._sensors.some(item=>item.kind==='acceleration'))return;
    try{
      if(typeof Accelerometer!=='function')throw new Error('Accelerometer unavailable');
      const accel=new Accelerometer({frequency:50});
      const read=()=>{
        const arrivalMs=performance.now();
        const orientationAgeMs=arrivalMs-this._head.latestAt;
        const quaternion=orientationAgeMs<=ORIENTATION_MAX_AGE_MS?this._head.latest:null;
        this._session.sample({
          accel:{x:accel.x,y:accel.y,z:accel.z,sensorTimestamp:accel.timestamp},
          quaternion,orientationAgeMs,
        });
        if(this._resumePending&&this._session.lastSample!==null){
          this._resumePending=false;
          this._session.confirm().catch(e=>{this._session.message='声音暂不可用，单击重试';console.warn('[rhythm] resume',String(e));});
        }
      };
      const error=e=>{
        this._dropSensor(item);
        this._resumePending=false;
        const session=this._session;
        session.interruptImu();
        if(session.mode==='calibrating')session.mode='sensor-error';
        else session.pause();
        session.trace('state',{state:'sensor-error',message:String(e?.message||e?.error||'unknown').slice(0,200)});
        session.message='动作传感器异常，请单击重试';
      };
      const item={sensor:accel,read,error,kind:'acceleration'};
      accel.addEventListener('reading',read);accel.addEventListener('error',error);
      this._sensors.push(item);accel.start();
      this._startHeadSensor();
    }catch(e){this._resumePending=false;this._stopSensors();this._session.interruptImu();this._session.mode='sensor-error';this._session.trace('state',{state:'sensor-error',message:String(e).slice(0,200)});this._session.message='当前宿主未提供动作传感器';console.warn('[rhythm] sensors',String(e));}
  },
  _showTutorialReady(){
    this._tutorialAutoPending=false;
    this._tutorialTapAt=null;
    this._leaveMenu();
    this._stopSensors();
    this._session.home();
    this._session.mode='tutorial-ready';
  },
  _updateMenu(now){
    if(!this._menuSensorAttempted){
      this._menuSensorAttempted=true;
      this._startHeadSensor();
    }
    if(!this._confirming&&this._menu.update(this._menuHead.pose(now),now)){
      this.handleTap('dwell');
    }
    const course=this._session.courses[this._menu.songIndex];
    const preview=this._menu.focus==='song'&&!this._confirming ? course : null;
    if(this._previewCourse!==preview){
      this._previewCourse=preview;
      if(preview)this._audio.startPreview?.(preview);
      else this._audio.stopPreview?.();
    }
    const audio=this._audio.previewState?.(now);
    return {
      songs:this._session.courses, songIndex:this._menu.songIndex, focus:this._menu.focus,
      previewPlaying:audio?.playing===true, previewProgress:audio?.progress||0,
      cursor:this._menu.cursor, dwellProgress:this._menu.dwellProgress,
    };
  },
  _leaveMenu(){
    this._previewCourse=null;
    this._audio?.stopPreview?.();
    this._menu?.resetAim();
    this._menuHead?.reset();
  },
  _returnToMenu(){
    this._tutorialAutoPending=false;this._tutorialTapAt=null;this._resumePending=false;
    this._tutorialVoice?.stop();
    this._menu.focusOn(this._menu.targets[this._menu.songIndex]);
    this._leaveMenu();
    this._stopSensors();
    this._session.home();
  },
  _saveTutorial(){
    this._menu.focusOn(this._menu.targets[this._menu.songIndex]);
    try{wx.setStorageSync(TUTORIAL_COMPLETE_KEY,true);}catch(e){console.warn('[rhythm] tutorial storage',String(e));}
  },
  _newRunId(){try{return crypto.randomUUID();}catch(e){return 'run_'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);}},
  _setLeaderboard(next){
    const previous=this._leaderboard;
    this._leaderboard={...previous,...next,revision:(previous.revision||0)+1};
  },
  _applyLeaderboard(song,data){
    const board={
      status:'ready',
      songId:song.id,songTitle:song.title,chartVersion:song.version,
      entries:Array.isArray(data?.entries)?data.entries.slice(0,8):[],
      me:data?.me||null,
      totalPlayers:Number.isInteger(data?.total_players)?data.total_players:0,
      message:'',at:performance.now(),
    };
    this._leaderboardCache.set(`${song.id}:${song.version}`,board);
    if(this._session.mode==='leaderboard'&&this._leaderboard.songId===song.id&&this._leaderboard.chartVersion===song.version){
      this._setLeaderboard(board);
    }
  },
  _openLeaderboard(song){
    if(!this._session.openLeaderboard())return;
    this._leaveMenu();
    this._refreshLeaderboard(song||this._session.courses[this._menu.songIndex]);
  },
  _stepLeaderboard(delta){
    const songs=this._session.courses;
    const index=songs.findIndex(song=>song.id===this._leaderboard.songId);
    this._refreshLeaderboard(songs[(Math.max(0,index)+delta+songs.length)%songs.length]);
  },
  _refreshLeaderboard(song){
    const {id:songId,version:chartVersion,title:songTitle}=song;
    if(!this._leaderboardClient){
      this._setLeaderboard({status:'error',songId,chartVersion,songTitle,entries:[],me:null,totalPlayers:0,message:'排行榜未配置'});
      return;
    }
    const cached=this._leaderboardCache.get(`${songId}:${chartVersion}`);
    if(cached&&performance.now()-cached.at<60000){this._setLeaderboard(cached);return;}
    this._setLeaderboard({status:'loading',songId,chartVersion,songTitle,entries:[],me:null,totalPlayers:0,message:''});
    const token=this._leaderboard.revision;
    this._leaderboardClient.fetchLeaderboard({songId,chartVersion,limit:8})
      .then(data=>{if(this._session.mode==='leaderboard'&&this._leaderboard.revision===token)this._applyLeaderboard(song,data);})
      .catch(error=>{
        if(this._session.mode!=='leaderboard'||this._leaderboard.revision!==token)return;
        const code=error?.code||'';
        this._setLeaderboard({status:'error',entries:[],me:null,totalPlayers:0,
          message:code==='NO_ACCOUNT'?'登录后即可上榜':code==='NOT_CONFIGURED'?'排行榜未配置':code==='TIMEOUT'?'排行榜请求超时':code==='EMPTY_REPLY'?'榜单服务未返回数据':'排行榜暂不可用'});
        console.warn('[rhythm] leaderboard',code||'ERR',String(error?.message||error));
      });
  },
  async _confirm(){
    if(this._confirming||this._resumePending||!this._visible)return;
    this._confirming=true;
    try{
    const mode=this._session.mode;
    if(mode==='leaderboard'){this._session.closeLeaderboard();return;}
    if(mode==='playing'){this._session.pause();return;}
    if(mode==='result'&&this._resultAction===1){this._openLeaderboard(this._session.game?.course);return;}
    if(mode==='result'&&this._resultAction===2){this._returnToMenu();return;}
    if(mode==='home'&&this._menu.focus==='leaderboard'){
      this._openLeaderboard(this._session.courses[this._menu.songIndex]);return;
    }
    if(mode==='home'&&this._menu.focus==='tutorial'){
      this._showTutorialReady();return;
    }
    if(mode==='home'||mode==='result'||mode==='sensor-error'||mode==='tutorial-ready'){
      const tutorial=mode==='tutorial-ready'||(mode==='sensor-error'&&!!this._session.tutorial);
      if(tutorial)this._tutorialAutoPending=false;
      if(mode==='home'){
        this._session.selected=this._menu.songIndex;
        this._leaveMenu();
      }
      this._resultAction=0;
      this._posePending=true;this._poseValid=null;this._tutorialTapAt=null;
      this._runId=this._newRunId();this._scoreSubmittedFor=null;
      if(mode==='sensor-error')this._stopSensors();
      await this._session.start('imu',{tutorial});
      if(this._visible&&this._session.mode==='calibrating'){
        this._head.reset();
        this._startSensors();
      }
      return;
    }
    if(mode==='paused'){
      const generation=this._session.generation;
      await this._audio.prepare();
      if(!this._visible||this._session.mode!=='paused'||generation!==this._session.generation)return;
      this._resumePending=true;this._resumeDeadline=performance.now()+3000;
      this._session.message='等待动作信号恢复';this._session.lastSample=null;
      this._stopSensors();this._startSensors();
    }
    }finally{this._confirming=false;}
  },
  handleSurfaceTap(){
    if(performance.now()-this._lastSwipeAt<SWIPE_QUIET_MS)return;
    this.handleTap('surface');
  },
  handleTap(source='direct'){
    if(!this._visible)return;
    const now=performance.now();
    const gap=now-this._lastTapAt;
    if(gap<TAP_DEBOUNCE_MS||(source!==this._lastTapSource&&gap<DUPLICATE_TAP_MS))return;
    this._lastTapAt=now;this._lastTapSource=source;
    const session=this._session;
    if(session.mode==='leaderboard'){session.closeLeaderboard();return;}
    if(session.mode==='calibrating'||session.mode==='tutorial'){
      const gap=this._tutorialTapAt===null?Infinity:now-this._tutorialTapAt;
      if(gap<=DOUBLE_TAP_MS)this._returnToMenu();
      else this._tutorialTapAt=now;
      return;
    }
    if(session.mode==='home')this._menu.focusAimed(this._menuHead.pose(now),now);
    this._confirm().catch(e=>console.error('[rhythm] confirm',String(e)));
  },
  _handlesKey(key){
    if(!this._visible||!key)return false;
    const mode=this._session.mode;
    if(key==='back')return mode!=='home';
    if(key==='confirm')return true;
    return mode==='home'||mode==='result'||mode==='leaderboard';
  },
  onKeyDown(event){
    const key=templeKey(event);
    // Backspace owns its host default on keyup. Keep keydown observational,
    // matching the proven single-Page handling used by NodCue.
    if(key==='back')return;
    if(!this._handlesKey(key))return;
    event.preventDefault?.();
  },
  onKeyUp(event){
    const key=templeKey(event);
    if(key==='back'){
      if(!this._visible||this._session.mode==='home')return;
      if(event && event.preventDefault)event.preventDefault();
      if(event && event.stopImmediatePropagation)event.stopImmediatePropagation();
      else if(event && event.stopPropagation)event.stopPropagation();
      if(event.repeat)return;
      const mode=this._session.mode;
      if(mode==='leaderboard')this._session.closeLeaderboard();
      else if(mode==='playing')this._session.pause();
      else if(mode!=='home')this._returnToMenu();
      return;
    }
    if(!this._handlesKey(key))return;
    event.preventDefault?.();
    if(key==='confirm'){if(!event.repeat)this.handleTap('key');return;}
    const now=performance.now();
    const mode=this._session.mode;
    // Firmware sends a burst of arrow events for a single temple swipe.
    const swipeGap=now-this._lastSwipeAt;
    this._lastSwipeAt=now;
    if(event.repeat||swipeGap<SWIPE_QUIET_MS)return;
    const delta=key==='previous'?-1:1;
    if(mode==='result')this._resultAction=(this._resultAction+delta+3)%3;
    else if(mode==='leaderboard')this._stepLeaderboard(delta);
    else if(!this._confirming)this._menu.step(delta,now);
  },
  async _save(result,state){
    this._stopSensors();
    const runId=this._runId||this._newRunId();
    this._runId=runId;
    const payload={...result,id:runId,source:'imu'};
    // Storage is unreliable on this device; a failed write must not stop the
    // leaderboard submission or the on-screen result.
    try{
      const history=wx.getStorageSync('rhythm-history')||[];
      wx.setStorageSync('rhythm-history',[{...payload,score:state.score,accuracy:state.accuracy},...history].slice(0,20));
      this._session.saved='成绩已保存在眼镜';
    }catch(e){this._session.saved='本机成绩保存失败';console.warn('[rhythm] history',String(e));}
    if(!this._leaderboardClient)return;
    if(this._scoreSubmittedFor===runId)return;
    this._scoreSubmittedFor=runId;
    this._session.saved='正在提交排行榜…';
    try{
      const data=await this._leaderboardClient.submitScore({
        songId:state.course.id,chartVersion:state.course.version||1,runId,
        score:state.score,maxCombo:state.maxCombo,perfect:state.perfect,good:state.good,ok:state.ok,miss:state.miss,
      });
      // A replay can start while the request is in flight; never paint the old
      // run's rank onto the new session.
      if(this._runId!==runId)return;
      this._applyLeaderboard(state.course,data);
      const position=data?.submitted?.position;
      this._session.saved=position?`已上榜 · 第 ${position} 名`:'成绩已提交';
    }catch(e){
      if(this._runId!==runId)return;
      this._session.saved='排行榜未同步 · 本地已保存';
      console.warn('[rhythm] leaderboard submit',String(e?.message||e));
    }
  },
};
</script>
<page>
  <view class="root" bindtap="handleSurfaceTap"><canvas id="rhythm" width="480" height="352" class="game"></canvas></view>
</page>
<style>
.root { width: 480px; height: 352px; background-color: #000000; }
.game { width: 480px; height: 352px; }
</style>
