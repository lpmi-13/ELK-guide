class IncidentCoachPanel {
  constructor(host) {
    this.host = host;
    this.root = host.attachShadow({mode: 'open'});
    this.root.innerHTML = `<style>${IncidentCoachPanel.styles}</style>
      <aside class="panel" aria-label="Incident coach">
        <header><span class="live-dot"></span><strong>Incident coach</strong><button id="stop" title="Stop automation">Stop</button></header>
        <div class="progress" aria-hidden="true"><span></span></div>
        <p id="mode"></p><h2 id="objective">Waiting for a session…</h2><p id="narration" aria-live="polite"></p>
        <div class="actions"><button id="pause">Pause</button><button id="hint">Hint</button><button id="demonstrate">Show me</button></div>
        <form id="diagnosis" hidden>
          <label>Faulty service<input name="service" required></label>
          <label>Failure type<select name="fault_type"><option value="latency">Latency</option><option value="error">Errors</option><option value="unavailable">Unavailable</option></select></label>
          <label>Affected route<input name="affected_route" placeholder="/checkout" required></label>
          <label>Trace ID<input name="trace_id" required></label>
          <label>Evidence<textarea name="evidence" required></textarea></label>
          <button type="submit">Submit diagnosis</button>
        </form>
        <p id="status" role="status"></p>
      </aside>`;
    this.panel = this.root.querySelector('.panel');
    this.cursor = new IncidentCursor(this.root);
    this.spotlight = new IncidentSpotlight(this.root);
    this.debrief = new IncidentDebrief(this.root);
    this.paused = false;
    this.root.querySelector('#pause').onclick = event => {
      this.paused = !this.paused;
      event.target.textContent = this.paused ? 'Resume' : 'Pause';
      this.onPause?.(this.paused);
    };
    this.root.querySelector('#hint').onclick = () => this.onHint?.();
    this.root.querySelector('#demonstrate').onclick = () => this.onDemonstrate?.();
    this.root.querySelector('#stop').onclick = () => this.onStop?.();
    this.root.querySelector('#diagnosis').addEventListener('submit', event => {
      event.preventDefault();
      this.onDiagnosis?.(Object.fromEntries(new FormData(event.target)));
    });
  }

  showCommand(command, target) {
    this.host.hidden = false;
    this.root.querySelector('#mode').textContent = `${command.mode} · step ${command.step_index + 1} of ${command.step_count}`;
    this.root.querySelector('#objective').textContent = command.step_id.replaceAll('-', ' ');
    this.root.querySelector('#narration').textContent = command.narration || '';
    this.root.querySelector('.progress span').style.width = `${100 * command.step_index / command.step_count}%`;
    this.root.querySelector('#demonstrate').hidden = command.mode !== 'guided';
    this.root.querySelector('#hint').hidden = command.mode === 'demonstration';
    this.root.querySelector('#diagnosis').hidden = command.type !== 'request_diagnosis';
    if (target && command.mode !== 'challenge') this.spotlight.show(target); else this.spotlight.hide();
  }

  toast(message, error = false) {
    const status = this.root.querySelector('#status');
    status.textContent = message;
    status.className = error ? 'error' : '';
  }

  stop() {
    this.spotlight.hide();
    this.cursor.hide();
    this.host.hidden = true;
  }

  static styles = `
    :host { all: initial; position: fixed; z-index: 2147483647; inset: 0; pointer-events: none; font: 14px system-ui,sans-serif; color: #17212b; }
    .panel { pointer-events: auto; position: fixed; top: 72px; right: 18px; width: 330px; max-height: calc(100vh - 100px); overflow: auto; box-sizing: border-box; padding: 16px; border: 1px solid #b6c6d6; border-radius: 10px; background: #fff; box-shadow: 0 12px 40px #17212b3d; }
    header { display:flex; align-items:center; gap:8px; } header strong { flex:1; } .live-dot { width:9px;height:9px;border-radius:50%;background:#1aa87a;box-shadow:0 0 0 4px #1aa87a22; }
    h2 { margin: 14px 0 6px; font-size: 17px; text-transform: capitalize; } p { line-height:1.45; } #mode { color:#536170; font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
    button { border:1px solid #8293a3;border-radius:5px;background:#f5f7f9;padding:6px 9px;cursor:pointer; } button:hover,button:focus-visible { outline:2px solid #006bb4;outline-offset:1px; }
    #stop { color:#a32b1c;border-color:#d77d72; } .actions { display:flex; gap:7px; margin-top:12px; }
    .progress { height:4px;background:#dce4eb;margin:13px 0;border-radius:4px;overflow:hidden; }.progress span { display:block;height:100%;background:#006bb4;transition:width .3s; }
    label { display:block;font-weight:650;margin-top:10px; } input,select,textarea { display:block;width:100%;box-sizing:border-box;margin-top:3px;padding:7px;border:1px solid #9ba9b6;border-radius:4px;font:inherit; } textarea { min-height:58px; }
    #diagnosis button { margin-top:12px;background:#006bb4;color:#fff;border:0; } #status { min-height:18px;color:#147d5c; }.error { color:#a32b1c!important; }
    .incident-spotlight { position:fixed;display:none;box-sizing:border-box;border:3px solid #ffb000;border-radius:7px;box-shadow:0 0 0 9999px #10182070;pointer-events:none;transition:all .25s; }
    .incident-cursor { position:fixed;left:-12px;top:-12px;width:24px;height:24px;opacity:0;pointer-events:none;transition:transform .65s cubic-bezier(.2,.75,.25,1),opacity .15s; }
    .incident-cursor.visible { opacity:1; }.incident-cursor:before { content:'➤';display:block;color:#ffb000;font-size:28px;filter:drop-shadow(0 2px 2px #0008);transform:rotate(-25deg); }
    .incident-cursor span { position:absolute;inset:0;border:2px solid #ffb000;border-radius:50%;opacity:0; }.incident-cursor.clicked span { animation:click-ring .5s; }
    @keyframes click-ring { from{opacity:1;transform:scale(.3)}to{opacity:0;transform:scale(2)} }
    dialog.incident-debrief { pointer-events:auto;max-width:540px;border:0;border-radius:10px;padding:24px;box-shadow:0 14px 50px #0006;color:#17212b; }.incident-debrief::backdrop{background:#101820aa}.dialog-close{float:right;border:0;font-size:22px}.incident-debrief li{display:flex;justify-content:space-between;padding:5px 0}.incident-debrief .total{font-size:20px;font-weight:750}
    @media (prefers-reduced-motion: reduce) { *, .incident-cursor, .progress span { transition:none!important;animation:none!important; } }
  `;
}

globalThis.IncidentCoachPanel = IncidentCoachPanel;
