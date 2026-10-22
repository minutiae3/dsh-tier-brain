/**
 * dsh-tier-brain 客户端（v0.1.1）
 *
 * 只做三件事：
 *   1. 找到"真正的会话输入框"——[data-composer-seat] 里的 Lexical 编辑器；
 *   2. 输入停下来后去问宿主 POST /dsh-tier-brain/preview（规则只有宿主一份）；
 *   3. 在输入框上沿外侧显示一句：建议的模型 + 推理等级。
 *
 * 明确不做：不算分、不展示分数/难度条/理由/置信度、不出现"为什么"按钮。
 * 输入框不在当前界面（设置、插件市场、别的会话）时，卡片一律隐藏。
 */
window.__ModuleLoader__.load({
  id: 'dsh-tier-brain',
  factory: () => {
    const SEAT = '[data-composer-seat]';
    const EDITOR = '[data-composer-input="true"], [data-lexical-editor="true"]';
    const SESSION = '[data-conversation-session]';
    const CARD_ID = 'dsh-tier-brain-advice';
    const STYLE_ID = 'dsh-tier-brain-style';
    const DEBOUNCE_MS = 260;
    const MIN_INTERVAL_MS = 400;

    const LABEL = {
      1: { dot: '#22c55e', name: '省' },
      2: { dot: '#eab308', name: '平' },
      3: { dot: '#ef4444', name: '强' },
    };

    function visible(el) {
      if (!el) return false;
      if (el.closest('[hidden], [aria-hidden="true"]')) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 8) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      return true;
    }

    /**
     * 座位是不是"真的露在外面"。
     * 设置页、插件市场、命令面板这类通常是盖在聊天页上的浮层，
     * 底下 composer 的 rect 依然有效——只查 visible() 是不够的，
     * 必须在座位中心做一次命中测试，被别的层盖住就当它不存在。
     */
    function onTop(el) {
      const r = el.getBoundingClientRect();
      const left = Math.max(r.left, 0);
      const right = Math.min(r.right, window.innerWidth);
      const top = Math.max(r.top, 0);
      const bottom = Math.min(r.bottom, window.innerHeight);
      if (right - left < 20 || bottom - top < 8) return false;
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      if (!hit) return false;
      return hit === el || el.contains(hit);
    }

    /** 当前可见的会话输入框；找不到就返回 null，调用方据此隐藏卡片。 */
    function findComposer() {
      const seats = Array.from(document.querySelectorAll(SEAT));
      for (const seat of seats) {
        const editor = seat.querySelector(EDITOR);
        if (!editor) continue;
        if (!visible(seat) || !visible(editor)) continue;
        if (!onTop(seat)) continue;
        return { seat, editor };
      }
      return null;
    }

    function readText(editor) {
      if (!editor) return '';
      if (typeof editor.value === 'string') return editor.value.trim();
      const text = editor.innerText || editor.textContent || '';
      return text.replace(/\u200b/g, '').trim();
    }

    function sessionOf(editor) {
      const host = editor.closest(SESSION);
      if (host) {
        const id = host.getAttribute('data-conversation-session');
        if (id) return id;
      }
      const any = document.querySelector(SESSION);
      return (any && any.getAttribute('data-conversation-session')) || '';
    }

    function apply() {
      if (document.getElementById(CARD_ID)) return undefined;

      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = [
        '#' + CARD_ID + '{position:fixed;z-index:9998;display:none;box-sizing:border-box;pointer-events:none;',
        'padding:4px 9px 4px 8px;border-radius:999px;border:1px solid rgba(128,128,128,.28);',
        'background:rgba(24,24,27,.90);color:#e5e7eb;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
        'box-shadow:0 4px 16px rgba(0,0,0,.26);backdrop-filter:blur(6px);white-space:nowrap;overflow:hidden;}',
        '#' + CARD_ID + ' .tb-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:1px;}',
        '#' + CARD_ID + ' .tb-model{font-variant-numeric:tabular-nums;}',
        '#' + CARD_ID + ' .tb-sep{opacity:.45;margin:0 5px;}',
        '#' + CARD_ID + ' .tb-effort{opacity:.9;}',
        '#' + CARD_ID + ' .tb-peak{color:#f59e0b;margin-left:6px;}',
        '#' + CARD_ID + ' .tb-peak:empty{display:none;}',
        '#' + CARD_ID + ' .tb-ctx{color:#8b9bb4;margin-left:6px;}',
        '#' + CARD_ID + ' .tb-ctx:empty{display:none;}',
        '@media (prefers-color-scheme: light){#' + CARD_ID + '{background:rgba(255,255,255,.95);color:#18181b;border-color:rgba(0,0,0,.12);}}',
      ].join('');
      document.head.appendChild(style);

      const card = document.createElement('div');
      card.id = CARD_ID;
      card.setAttribute('role', 'status');
      card.setAttribute('aria-live', 'polite');
      document.body.appendChild(card);

      const dot = document.createElement('span');
      dot.className = 'tb-dot';
      const modelEl = document.createElement('span');
      modelEl.className = 'tb-model';
      const sep = document.createElement('span');
      sep.className = 'tb-sep';
      sep.textContent = '·';
      const effortEl = document.createElement('span');
      effortEl.className = 'tb-effort';
      // 只在高峰时段出现的省钱提示；谷时不占位、不加噪。
      const peakEl = document.createElement('span');
      peakEl.className = 'tb-peak';
      peakEl.textContent = '· 高峰';
      // 上下文已经很长时出现：提醒省档在这里省不到输入成本。
      const ctxEl = document.createElement('span');
      ctxEl.className = 'tb-ctx';
      ctxEl.textContent = '· 长上下文';
      card.append(dot, modelEl, sep, effortEl, peakEl, ctxEl);

      let timer = 0;
      let lastKey = '';
      let lastAt = 0;
      let requestSeq = 0;
      let disposed = false;

      function hide() {
        card.style.display = 'none';
      }

      function place(seat) {
        const r = seat.getBoundingClientRect();
        const MARGIN = 8;
        // 关键：先解除上一次设的 maxWidth 再量 scrollWidth，否则宽度只会越压越窄，
        // 内容变长（多了 ·高峰 ·长上下文）时后缀会被旧宽度裁掉，看起来像"被遮挡/超出"。
        card.style.maxWidth = 'none';
        const natural = card.scrollWidth;
        const viewportMax = Math.max(120, window.innerWidth - MARGIN * 2);
        const width = Math.min(natural, viewportMax);

        // 左边对齐输入区；若内容较宽导致越出右缘，则整体左移，保持完整不裁切
        let left = r.left;
        if (left + width > window.innerWidth - MARGIN) {
          left = window.innerWidth - MARGIN - width;
        }
        if (left < MARGIN) left = MARGIN;

        // 贴在输入区上沿外侧，绝对不压住输入区里的按钮
        card.style.left = left + 'px';
        card.style.bottom = (window.innerHeight - r.top + 8) + 'px';
        card.style.maxWidth = width + 'px';
      }

      function paint(advice, seat) {
        const meta = LABEL[advice.tier] || LABEL[2];
        dot.style.background = advice.color || meta.dot;
        modelEl.textContent = advice.model;
        effortEl.textContent = advice.effort;
        peakEl.style.display = advice.peak ? '' : 'none';
        ctxEl.style.display = advice.longContext ? '' : 'none';
        card.style.display = 'block';
        place(seat);
      }

      async function refresh(force) {
        if (disposed) return;
        const found = findComposer();
        if (!found) {
          hide();
          lastKey = '';
          return;
        }
        const { seat, editor } = found;
        const text = readText(editor);
        if (!text) {
          hide();
          lastKey = '';
          return;
        }
        const sessionId = sessionOf(editor);
        const key = sessionId + '\n' + text;
        // 卡片已经藏起来时不能只看 key 相同就跳过——上次可能是请求失败藏起来的
        if (!force && key === lastKey && card.style.display !== 'none') {
          place(seat);
          return;
        }
        lastKey = key;

        const now = Date.now();
        const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastAt));
        if (wait > 0) {
          window.clearTimeout(timer);
          timer = window.setTimeout(() => refresh(true), wait);
          return;
        }
        lastAt = now;
        const seq = ++requestSeq;

        try {
          const res = await fetch('/dsh-tier-brain/preview', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text, sessionId }),
          });
          if (!res.ok) {
            hide();
            return;
          }
          const data = await res.json();
          if (seq !== requestSeq || disposed) return;
          if (!data || !data.advice || !data.advice.model) {
            hide();
            return;
          }
          // 请求回来时用户可能已经切走界面，重新确认一次再画
          const again = findComposer();
          if (!again || readText(again.editor) !== text) {
            hide();
            return;
          }
          paint(data.advice, again.seat);
        } catch {
          hide();
        }
      }

      function schedule() {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => refresh(false), DEBOUNCE_MS);
      }

      const onInput = (event) => {
        const found = findComposer();
        if (!found) {
          hide();
          return;
        }
        const target = event.target;
        if (target !== found.editor && !found.seat.contains(target)) return;
        schedule();
      };

      const onComposition = () => schedule();
      const onResize = () => {
        const found = findComposer();
        if (found && card.style.display !== 'none') place(found.seat);
      };
      const onScroll = () => {
        const found = findComposer();
        if (found && card.style.display !== 'none') place(found.seat);
      };

      document.addEventListener('input', onInput, true);
      document.addEventListener('compositionend', onComposition, true);
      window.addEventListener('resize', onResize, true);
      document.addEventListener('scroll', onScroll, true);

      // 界面切换（会话 ↔ 设置 ↔ 插件市场）不一定有 input 事件，靠轮询兜底；
      // 800ms 一次很便宜，但足够让卡片在任何界面变化后立刻消失。
      const poll = window.setInterval(() => {
        const found = findComposer();
        if (!found) {
          hide();
          lastKey = '';
          return;
        }
        const text = readText(found.editor);
        if (!text) {
          hide();
          lastKey = '';
          return;
        }
        const key = sessionOf(found.editor) + '\n' + text;
        if (key !== lastKey || card.style.display === 'none') refresh(false);
        else place(found.seat);
      }, 800);

      window.setTimeout(() => refresh(true), 500);

      return () => {
        disposed = true;
        window.clearInterval(poll);
        window.clearTimeout(timer);
        document.removeEventListener('input', onInput, true);
        document.removeEventListener('compositionend', onComposition, true);
        window.removeEventListener('resize', onResize, true);
        document.removeEventListener('scroll', onScroll, true);
        card.remove();
        style.remove();
      };
    }

    return { apply };
  },
});
