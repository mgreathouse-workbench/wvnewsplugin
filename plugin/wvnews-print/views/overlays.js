// The date picker (UXP draws no calendar for <input type="date">) and the
// sign-in screen.

function createOverlays({ html, cx, fmt, ui }) {
  function datePicker(s) {
    const dp = s.datePicker;
    if (!dp) return '';
    const { y, m } = dp.view;
    const body = dp.mode === 'years' ? years(dp) : days(dp, y, m);
    return html`<div class="overlay" data-action="cancelDate">
      <div class="dialog" data-action="noop" role="dialog" aria-label="Choose a date">
        <div class="dialog-head">
          <div class="dialog-kicker">Edition date</div>
          <div class="dialog-title">${fmt.fmtDate(dp.pending) || 'Choose a date'}</div>
        </div>
        <div class="cal-nav">
          <sp-action-button size="s" quiet data-action="toggleYears">${fmt.MONTHS_LONG[m]} ${y} ${dp.mode === 'years' ? '▴' : '▾'}</sp-action-button>
          ${dp.mode === 'days' ? html`<span class="cal-arrows">
            <sp-action-button size="s" quiet data-action="shiftMonth" data-arg="-1" title="Previous month">‹</sp-action-button>
            <sp-action-button size="s" quiet data-action="shiftMonth" data-arg="1" title="Next month">›</sp-action-button>
          </span>` : ''}
        </div>
        ${body}
        <div class="dialog-foot">
          ${ui.button({ label: 'Cancel', action: 'cancelDate', variant: 'secondary', quiet: true })}
          ${ui.button({ label: 'OK', action: 'confirmDate', variant: 'cta' })}
        </div>
      </div>
    </div>`;
  }

  function days(dp, y, m) {
    const first = new Date(y, m, 1).getDay();
    const count = new Date(y, m + 1, 0).getDate();
    const today = fmt.todayISO();
    const cells = [];
    for (let i = 0; i < first; i++) cells.push(html`<span class="cal-cell"></span>`);
    for (let d = 1; d <= count; d++) {
      const iso = fmt.isoFrom(y, m, d);
      cells.push(html`<span class="cal-cell"><span class="${cx('cal-day', iso === dp.pending && 'is-selected', iso === today && 'is-today')}"
        data-action="pickDay" data-arg="${iso}">${d}</span></span>`);
    }
    return html`<div class="cal-grid cal-dow">${fmt.DOW_LETTERS.map((w) => html`<span class="cal-cell">${w}</span>`)}</div>
      <div class="cal-grid">${cells}</div>`;
  }

  function years(dp) {
    const start = dp.view.y - 6;
    const out = [];
    for (let i = 0; i < 12; i++) {
      const yr = start + i;
      out.push(html`<span class="${cx('cal-year', yr === dp.view.y && 'is-selected')}" data-action="pickYear" data-arg="${yr}">${yr}</span>`);
    }
    return html`<div class="cal-years">${out}</div>`;
  }

  function signIn(s) {
    const busy = !!s.activity;
    return html`<div class="signin">
      <div class="signin-mark">WV News</div>
      <div class="signin-title">Sign in to WVNews Print</div>
      <div class="signin-text">Use your WV News Google account. Your browser opens for sign-in and shows a code to paste here.</div>
      <div class="signin-step">
        <div class="signin-step-label">1. Sign in with your browser</div>
        ${ui.button({ label: 'Open Sign-In Page', action: 'openSignIn', variant: 'cta', disabled: busy, wide: true })}
      </div>
      <div class="signin-step">
        <div class="signin-step-label">2. Paste the code</div>
        ${ui.textfield({ id: 'signin-code', input: 'setSignInCode', value: s.signInCode || '', placeholder: 'Code from your browser', enter: 'finishSignIn', className: 'grow' })}
        ${ui.button({ label: 'Sign In', action: 'finishSignIn', variant: 'primary', disabled: busy, wide: true })}
      </div>
    </div>`;
  }

  return { datePicker, signIn };
}

module.exports = { createOverlays };
