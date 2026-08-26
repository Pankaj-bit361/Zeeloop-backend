(()=>{(()=>{if(window.__zealoopLoaded)return;window.__zealoopLoaded=!0;let p=document.currentScript,n={...window.zealoop||{}};p!=null&&p.dataset.publicKey&&!n.publicKey&&(n.publicKey=p.dataset.publicKey);let K=(()=>{try{return p!=null&&p.src?new URL(p.src).origin:""}catch{return""}})(),z=(n.apiUrl||K||"").replace(/\/$/,"");if(!n.publicKey||!z){console.warn("[zealoop] missing publicKey or api origin \u2014 widget not started");return}let m=new URLSearchParams({pk:n.publicKey});try{m.set("page",location.href)}catch{}n.theme&&m.set("theme",n.theme),n.accentColor&&m.set("accent",n.accentColor),n.background&&m.set("bg",n.background);let S=`${z}/widget/frame/?${m.toString()}`,v=new URL(S,location.href).origin,C=e=>e&&/^#[0-9a-fA-F]{6}$/.test(e.trim())?e.trim():null,U=e=>{let o=L=>L<=.03928?L/12.92:Math.pow((L+.055)/1.055,2.4),i=o(parseInt(e.slice(1,3),16)/255),r=o(parseInt(e.slice(3,5),16)/255),k=o(parseInt(e.slice(5,7),16)/255);return .2126*i+.7152*r+.0722*k>.35?"#0c0a09":"#fafaf9"};function E(e,o){if(!t)return;let i=e||(o?"#f5f5f0":"#0c0a09");t.style.background=i,t.style.color=U(i),s&&(s.style.background=o?"#161412":"#fff")}let u=n.position==="bottom-left",I=20,_=200,M=(e,o)=>{let i=Number(e);return Number.isFinite(i)&&i>=0&&i<=_?i:o};function q(e){(e.position==="bottom-left"||e.position==="bottom-right")&&(u=e.position==="bottom-left");let o=M(e.sideSpacing,I),i=M(e.bottomSpacing,I);for(let[r,k]of[[t,i],[s,i+72]])r&&(r.style.bottom=`${k}px`,r.style.left=u?`${o}px`:"",r.style.right=u?"":`${o}px`,r===s&&(r.style.transformOrigin=`bottom ${u?"left":"right"}`))}let O=window.matchMedia("(prefers-reduced-motion: reduce)").matches,d=null,g=null,t=null,l=null,s=null,c=null,w=!1,a=!1,b=0,$="us",A=[],R=`
    :host { all: initial; }
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .launcher {
      position: fixed; bottom: 20px; ${u?"left":"right"}: 20px;
      width: 56px; height: 56px; border-radius: 50%;
      background: #0c0a09; border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 8px 28px rgba(12,10,9,0.32), 0 2px 8px rgba(12,10,9,0.2);
      z-index: ${n.zIndex||2147483e3};
      transition: transform .2s cubic-bezier(.22,1,.36,1), box-shadow .2s;
      transform: scale(0); opacity: 0;
    }
    .launcher.in { transform: scale(1); opacity: 1; animation: zl-pop .4s cubic-bezier(.22,1,.36,1); }
    @keyframes zl-pop { 0% { transform: scale(0); } 65% { transform: scale(1.08); } 100% { transform: scale(1); } }
    .launcher:hover { transform: scale(1.06); box-shadow: 0 12px 36px rgba(12,10,9,0.38), 0 2px 8px rgba(12,10,9,0.2); }
    .launcher:active { transform: scale(.94); }
    .launcher:focus-visible { outline: 2px solid #0d9488; outline-offset: 3px; }
    .launcher svg { position: absolute; transition: opacity .18s, transform .18s; }
    .icon-mark { opacity: 1; transform: rotate(0) scale(1); }
    .icon-close { opacity: 0; transform: rotate(-45deg) scale(.7); }
    .launcher.open .icon-mark { opacity: 0; transform: rotate(45deg) scale(.7); }
    .launcher.open .icon-close { opacity: 1; transform: rotate(0) scale(1); }
    .badge {
      position: absolute; top: -2px; ${u?"left":"right"}: -2px;
      min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px;
      background: #f87171; color: #fff; font-size: 11px; font-weight: 700;
      display: none; align-items: center; justify-content: center;
      border: 2px solid #fff; line-height: 1;
    }
    .badge.show { display: flex; animation: zl-badge .25s cubic-bezier(.34,1.56,.64,1); }
    @keyframes zl-badge { from { transform: scale(.4); } to { transform: scale(1); } }
    .panel {
      position: fixed; bottom: 92px; ${u?"left":"right"}: 20px;
      width: 400px; height: min(704px, calc(100dvh - 120px));
      min-height: 320px;
      border-radius: 16px; overflow: hidden; background: #fff;
      box-shadow: 0 12px 56px rgba(12,10,9,0.24), 0 2px 12px rgba(12,10,9,0.12);
      z-index: ${n.zIndex||2147483e3};
      opacity: 0; transform: translateY(14px) scale(.97);
      transform-origin: bottom ${u?"left":"right"};
      transition: opacity .2s cubic-bezier(.22,1,.36,1), transform .3s cubic-bezier(.3,1.36,.6,1), visibility .2s;
      pointer-events: none; visibility: hidden;
    }
    .panel.open { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; visibility: visible; }
    .panel iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
    @media (max-width: 559px) {
      .panel { inset: 0; width: 100%; height: 100dvh; border-radius: 0; bottom: 0; }
      .launcher.open { transform: scale(0); opacity: 0; pointer-events: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .launcher, .panel, .launcher svg { transition: none; }
      .launcher.in, .badge.show { animation: none; }
    }
    @media print { .launcher, .panel { display: none !important; } }
  `,D=`
    <svg class="icon-mark" width="28" height="28" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M5.75 8A13 13 0 0 1 26.25 8L5.75 24A13 13 0 0 0 26.25 24" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="29" cy="16" r="2.2" fill="currentColor"/>
    </svg>`,Q=`
    <svg class="icon-close" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6"/>
    </svg>`;function h(e){w&&(c!=null&&c.contentWindow)?c.contentWindow.postMessage(e,v):A.push(e)}function N(){c||!s||(c=document.createElement("iframe"),c.src=S,c.title="Zealoop messenger",c.allow="clipboard-write",s.appendChild(c))}window.addEventListener("message",e=>{var i;if(e.origin!==v||!e.data||typeof e.data!="object")return;let o=e.data;switch(o.type){case"zealoop:ready":{w=!0,n.identity&&h({type:"zealoop:identify",identity:n.identity}),h({type:"zealoop:visibility",open:a});for(let r of A.splice(0))h(r);break}case"zealoop:booted":{o.agentName&&($=o.agentName,x());break}case"zealoop:close":f(!1);break;case"zealoop:theme":{let r=e.data;E(C(r.accent),r.theme==="dark"),q(r);break}case"zealoop:unread":{b=(i=o.count)!=null?i:0,l&&(l.textContent=b>9?"9+":String(b),l.classList.toggle("show",b>0&&!a));break}}});function x(){t==null||t.setAttribute("aria-label",a?"Close chat":`Chat with ${$}`),t==null||t.setAttribute("aria-expanded",String(a))}function f(e){!d||e===a||(a=e,N(),t==null||t.classList.toggle("open",a),s==null||s.classList.toggle("open",a),x(),h({type:"zealoop:visibility",open:a}),a?(b=0,l==null||l.classList.remove("show")):t==null||t.focus({preventScroll:!0}))}function T(){if(d)return;d=document.createElement("div"),d.id="zealoop-widget",g=d.attachShadow({mode:"open"});let e=document.createElement("style");if(e.textContent=R,g.appendChild(e),s=document.createElement("div"),s.className="panel",g.appendChild(s),t=document.createElement("button"),t.type="button",t.className="launcher",t.innerHTML=D+Q,E(C(n.accentColor),n.theme==="dark"),l=document.createElement("span"),l.className="badge",l.setAttribute("aria-hidden","true"),t.appendChild(l),t.addEventListener("click",()=>f(!a)),g.appendChild(t),x(),(n.hideLauncher||n.customLauncherSelector)&&(t.style.display="none"),n.customLauncherSelector)try{document.querySelectorAll(n.customLauncherSelector).forEach(o=>{o.addEventListener("click",i=>{i.preventDefault(),f(!a)})})}catch{console.warn("[zealoop] customLauncherSelector is not a valid selector:",n.customLauncherSelector)}document.body.appendChild(d),O?t.classList.add("in"):requestAnimationFrame(()=>setTimeout(()=>t==null?void 0:t.classList.add("in"),150)),N()}function j(){d==null||d.remove(),d=g=t=l=s=c=null,w=!1,a=!1}function H(...e){try{let[o,i]=e;switch(o){case"open":f(!0);break;case"close":f(!1);break;case"toggle":f(!a);break;case"identify":n.identity=i,h({type:"zealoop:identify",identity:n.identity});break;case"shutdown":j();break;case"boot":T();break}}catch(o){console.warn("[zealoop] command failed",o)}}let y=window.Zealoop;window.Zealoop=H;let F=()=>{try{if(T(),y!=null&&y.q)for(let e of y.q)H(...e)}catch(e){console.warn("[zealoop] failed to start",e)}};document.readyState==="loading"?document.addEventListener("DOMContentLoaded",F,{once:!0}):F()})();})();
