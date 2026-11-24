<script def>
{
  "navigationBarTitleText":"研究日志导出",
  "description":"将本机最近三局的 IMU 研究记录经本地 ADB 调试日志导出，不上传网络。",
  "schema":{"data":{"type":"object","properties":{"exportId":{"type":"string"}}}}
}
</script>
<script setup>
import wx from 'wx';
import { readResearchLogs } from '../../lib/research-log.js';

export default {
  data:{status:'正在读取本地记录…'},
  onLoad(query){
    this._active=true;
    this._exportId=/^[a-zA-Z0-9._-]{1,128}$/.test(query?.exportId||'')?query.exportId:crypto.randomUUID();
  },
  onReady(){
    try{
      const archive=readResearchLogs(wx);
      if(archive.indexError)throw new Error(archive.indexError);
      this._runs=archive.runs;this._runIndex=0;this._rowIndex=-1;this._eventCount=0;
      this._emit({kind:'begin',runCount:this._runs.length});
      // Pace output below logcat payload limits while preserving the game VM.
      this._timer=setInterval(()=>this._batch(),20);
    }catch(e){this.setData({status:'导出失败：'+String(e).slice(0,100)});}
  },
  _emit(row){
    const text=JSON.stringify({schemaVersion:1,exportId:this._exportId,...row});
    if(text.length>2600)throw new Error('单条记录过大，未截断输出');
    console.log('[rhythm-research] '+text);
  },
  _batch(){
    if(!this._active)return;
    try{
      for(let count=0;count<100;count++){
        if(this._runIndex>=this._runs.length){
          this._emit({kind:'end',runCount:this._runs.length,eventCount:this._eventCount});
          this.setData({status:'已输出 '+this._runs.length+' 局、'+this._eventCount+' 条记录。'});this._stop();return;
        }
        const run=this._runs[this._runIndex];
        if(this._rowIndex===-1){
          const {id,records,...summary}=run;
          this._emit({kind:'run',runId:id,...summary,records:records.length});this._rowIndex=0;
        }else if(this._rowIndex<run.records.length){
          this._emit({kind:'event',runId:run.id,event:run.records[this._rowIndex++]});this._eventCount++;
        }else{this._runIndex++;this._rowIndex=-1;}
      }
    }catch(e){this.setData({status:'导出失败：'+String(e).slice(0,100)});this._stop();}
  },
  _stop(){if(this._timer!=null)clearInterval(this._timer);this._timer=null;this._runs=null;},
  onHide(){this._active=false;this._stop();},
  onUnload(){this._active=false;this._stop();},
};
</script>
<page>
  <view class="export"><text class="title">IMU 研究日志</text><text class="status">{{status}}</text><text class="hint">记录仅经本地 ADB 导出。返回可退出。</text></view>
</page>
<style>
.export{width:480px;height:352px;background-color:#000000;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:22px;padding:24px;box-sizing:border-box;}
.title{font-size:22px;color:#40ff5e;font-weight:500;}
.status{font-size:16px;line-height:24px;color:rgba(64,255,94,0.82);text-align:center;}
.hint{font-size:12px;color:rgba(64,255,94,0.62);}
</style>
