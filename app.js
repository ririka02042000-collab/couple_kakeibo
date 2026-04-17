'use strict';

// ── 定数 ──────────────────────────────────────────
const CATEGORY_ICONS = {
  '食費':'🍽️','住居費':'🏠','交通費':'🚃','光熱費':'💡',
  '通信費':'📱','医療費':'🏥','娯楽費':'🎮','衣類':'👗',
  '外食':'🍜','旅行':'✈️','給与':'💰','その他':'📦'
};

const PAYER_INFO = {
  girlfriend: { emoji: '👩', class: 'girlfriend' },
  boyfriend:  { emoji: '👨', class: 'boyfriend' },
  joint:      { emoji: '🏦', class: 'joint' }
};

const TYPE_LABELS = {
  expense: '支出', deposit: '貯金入金', transfer: '振替'
};

// ── 状態 ──────────────────────────────────────────
let transactions = JSON.parse(localStorage.getItem('couple_kakeibo') || '[]');
let settings = JSON.parse(localStorage.getItem('couple_settings') || '{"gfName":"彼女","bfName":"彼氏","ratioHistory":[{"from":"1970-01-01","gfRatio":1,"bfRatio":1}]}');
// 旧フォーマットからの移行
if (!settings.ratioHistory) {
  settings.ratioHistory = [{ from: '1970-01-01', gfRatio: settings.gfRatio || 1, bfRatio: settings.bfRatio || 1 }];
}
let currentType        = 'expense';
let currentPayer       = 'girlfriend';
let currentTransferTo  = 'boyfriend';
let currentBeneficiary = 'none';
let viewMonth    = new Date().toISOString().slice(0, 7); // "YYYY-MM"

// ── ユーティリティ ─────────────────────────────────
const fmt  = n  => '¥' + Math.abs(n).toLocaleString('ja-JP');
const sign = (type, n) => {
  if (type === 'deposit') return '+' + fmt(n);
  if (type === 'transfer') return fmt(n);
  return '-' + fmt(n);
};
const fmtDate = d => {
  const dt = new Date(d + 'T00:00:00');
  return `${dt.getMonth()+1}/${dt.getDate()}`;
};
const escHtml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const save = () => {
  localStorage.setItem('couple_kakeibo', JSON.stringify(transactions));
  localStorage.setItem('couple_settings', JSON.stringify(settings));
};

// ── 割合取得（日付に対応した割合を返す）────────────────
function getRatioForDate(dateStr) {
  const sorted = [...settings.ratioHistory].sort((a,b) => a.from.localeCompare(b.from));
  let applicable = sorted[0];
  for (const r of sorted) {
    if (r.from <= dateStr) applicable = r;
  }
  return applicable;
}

// ── 名前適用 ──────────────────────────────────────
function applyNames() {
  document.getElementById('name-girlfriend-display').textContent = settings.gfName;
  document.getElementById('name-boyfriend-display').textContent  = settings.bfName;
  document.getElementById('payer-gf-label').textContent = settings.gfName;
  document.getElementById('payer-bf-label').textContent = settings.bfName;
  document.getElementById('setting-gf-name').value = settings.gfName;
  document.getElementById('setting-bf-name').value = settings.bfName;
  document.getElementById('ratio-gf-label').textContent       = settings.gfName;
  document.getElementById('ratio-bf-label').textContent       = settings.bfName;
  document.getElementById('transfer-to-gf-label').textContent = settings.gfName;
  document.getElementById('transfer-to-bf-label').textContent = settings.bfName;
  document.getElementById('ben-gf-label').textContent = settings.gfName;
  document.getElementById('ben-bf-label').textContent = settings.bfName;

  // フィルターの選択肢も更新
  const opts = document.querySelectorAll('#filter-payer option');
  opts[1].textContent = settings.gfName;
  opts[2].textContent = settings.bfName;

  // 割合履歴リストを描画
  renderRatioHistory();
}

function renderRatioHistory() {
  const listEl = document.getElementById('ratio-history-list');
  const sorted = [...settings.ratioHistory].sort((a,b) => b.from.localeCompare(a.from)); // 新しい順
  if (!sorted.length) { listEl.innerHTML = '<p style="font-size:0.78rem;color:var(--muted)">未設定</p>'; return; }
  listEl.innerHTML = sorted.map((r, i) => {
    const dateLabel = r.from === '1970-01-01' ? '初期設定（全期間）' : r.from + ' 〜';
    const canDelete = sorted.length > 1; // 最後の1件は削除不可
    return `
      <div class="ratio-history-item">
        <span class="rh-date">${dateLabel}</span>
        <span class="rh-ratio">${settings.gfName} ${r.gfRatio} : ${settings.bfName} ${r.bfRatio}</span>
        ${canDelete ? `<button class="rh-delete" data-from="${r.from}">✕</button>` : ''}
      </div>
    `;
  }).join('');

  // 削除ボタン
  listEl.querySelectorAll('.rh-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.ratioHistory = settings.ratioHistory.filter(r => r.from !== btn.dataset.from);
      save();
      renderRatioHistory();
      renderAll();
    });
  });
}

// ── 月フィルタ取得 ────────────────────────────────
function monthTx() {
  return transactions.filter(t => t.date.startsWith(viewMonth));
}

// ── ホーム描画 ────────────────────────────────────
function renderHome() {
  document.getElementById('current-month-label').textContent =
    viewMonth.replace('-', '年') + '月';

  const txs = monthTx();

  // 彼女支出（支出 + 振替送金 − 振替受取）
  const gfExp        = txs.filter(t => t.payer === 'girlfriend' && t.type === 'expense').reduce((s,t) => s+t.amount, 0);
  const gfTransferOut = txs.filter(t => t.payer === 'girlfriend' && t.type === 'transfer').reduce((s,t) => s+t.amount, 0);
  const gfTransferIn  = txs.filter(t => t.transferTo === 'girlfriend' && t.type === 'transfer').reduce((s,t) => s+t.amount, 0);
  // 共用財布払い個人支出
  const jointPersonalForGf = txs.filter(t => t.payer === 'joint' && t.type === 'expense' && t.beneficiary === 'girlfriend').reduce((s,t) => s+t.amount, 0);
  const gfTotal = gfExp + gfTransferOut - gfTransferIn + jointPersonalForGf;

  // 彼氏支出（支出 + 振替送金 − 振替受取）
  const bfExp        = txs.filter(t => t.payer === 'boyfriend' && t.type === 'expense').reduce((s,t) => s+t.amount, 0);
  const bfTransferOut = txs.filter(t => t.payer === 'boyfriend' && t.type === 'transfer').reduce((s,t) => s+t.amount, 0);
  const bfTransferIn  = txs.filter(t => t.transferTo === 'boyfriend' && t.type === 'transfer').reduce((s,t) => s+t.amount, 0);
  const jointPersonalForBf = txs.filter(t => t.payer === 'joint' && t.type === 'expense' && t.beneficiary === 'boyfriend').reduce((s,t) => s+t.amount, 0);
  const bfTotal = bfExp + bfTransferOut - bfTransferIn + jointPersonalForBf;
  // 共用財布残高（全期間）
  // 共用財布 残額（全期間）
  const allJointIn  = transactions.filter(t => t.type === 'deposit' || (t.type === 'transfer' && t.transferTo === 'joint')).reduce((s,t)=>s+t.amount,0);
  const allJointOut = transactions.filter(t => (t.type === 'transfer' && t.payer === 'joint') || (t.payer === 'joint' && t.type === 'expense')).reduce((s,t)=>s+t.amount,0);
  // その月の支出・入金（支出 + 振替出金、入金 + 振替入金）
  const monthJointExpOnly  = txs.filter(t => t.payer === 'joint' && t.type === 'expense').reduce((s,t)=>s+t.amount,0);
  const monthJointTransOut = txs.filter(t => t.payer === 'joint' && t.type === 'transfer').reduce((s,t)=>s+t.amount,0);
  const monthJointExp = monthJointExpOnly + monthJointTransOut;
  const monthJointIn  = txs.filter(t => t.type === 'deposit' || (t.type === 'transfer' && t.transferTo === 'joint')).reduce((s,t)=>s+t.amount,0);

  document.getElementById('gf-amount').textContent      = fmt(gfTotal);
  document.getElementById('bf-amount').textContent      = fmt(bfTotal);
  document.getElementById('joint-balance').textContent  = fmt(allJointIn - allJointOut);
  document.getElementById('joint-expense').textContent  = fmt(monthJointExp);
  document.getElementById('joint-in').textContent       = fmt(monthJointIn);

  // カテゴリ集計（支出のみ）
  const expTxs = txs.filter(t => t.type === 'expense');
  const catMap = {};
  expTxs.forEach(t => { catMap[t.category] = (catMap[t.category]||0) + t.amount; });
  const catSorted = Object.entries(catMap).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const maxCat = catSorted[0]?.[1] || 1;

  const chartEl = document.getElementById('category-chart');
  chartEl.innerHTML = catSorted.length ? catSorted.map(([cat, amt]) => `
    <div class="category-row">
      <span class="cat-icon">${CATEGORY_ICONS[cat]||'📦'}</span>
      <span class="cat-name">${cat}</span>
      <div class="cat-bar-wrap">
        <div class="cat-bar" style="width:${(amt/maxCat*100).toFixed(1)}%"></div>
      </div>
      <span class="cat-amount">${fmt(amt)}</span>
    </div>
  `).join('') : '<p class="empty-chart">支出データなし</p>';

  // 最近5件
  const recent = txs.slice().sort((a,b)=>b.date.localeCompare(a.date)||b.id-a.id).slice(0,5);
  renderTxList('home-tx-list', recent, false);
}

// ── 履歴描画 ──────────────────────────────────────
function renderHistory() {
  const payerF  = document.getElementById('filter-payer').value;
  const catF    = document.getElementById('filter-category').value;
  const typeF   = document.getElementById('filter-type').value;

  let list = transactions.slice().sort((a,b)=>b.date.localeCompare(a.date)||b.id-a.id);
  if (payerF) list = list.filter(t => t.payer === payerF);
  if (catF)   list = list.filter(t => t.category === catF);
  if (typeF)  list = list.filter(t => t.type === typeF);

  renderTxList('history-tx-list', list, true);
}

// ── 取引リスト共通描画 ────────────────────────────
function renderTxList(containerId, list, showDelete) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';

  if (!list.length) {
    el.innerHTML = '<p class="empty-msg">取引がありません</p>';
    return;
  }

  list.forEach(t => {
    const pi = PAYER_INFO[t.payer] || PAYER_INFO.joint;
    const payerName = t.payer === 'girlfriend' ? settings.gfName
                    : t.payer === 'boyfriend'  ? settings.bfName : '共用財布';

    let categoryText, metaText;
    if (t.type === 'transfer') {
      const toName = t.transferTo === 'girlfriend' ? settings.gfName
                   : t.transferTo === 'boyfriend'  ? settings.bfName : '共用財布';
      categoryText = `${payerName} → ${toName}`;
      metaText = fmtDate(t.date) + (t.note ? ' · ' + escHtml(t.note) : '');
    } else {
      const benName = t.beneficiary === 'girlfriend' ? settings.gfName
                    : t.beneficiary === 'boyfriend'  ? settings.bfName : null;
      categoryText = (t.category || TYPE_LABELS[t.type]) + (benName ? ` (${benName}個人)` : '');
      metaText = [payerName, fmtDate(t.date), t.note ? escHtml(t.note) : ''].filter(Boolean).join(' · ');
    }

    const item = document.createElement('div');
    item.className = 'tx-item';
    item.innerHTML = `
      <div class="tx-payer-badge ${pi.class}">${pi.emoji}</div>
      <div class="tx-info">
        <div class="tx-category">${categoryText}</div>
        <div class="tx-meta">${metaText}</div>
      </div>
      <div class="tx-right">
        <div class="tx-amount ${t.type}">${sign(t.type, t.amount)}</div>
        ${showDelete ? `<button class="tx-delete" data-id="${t.id}">✕</button>` : ''}
      </div>
    `;
    el.appendChild(item);
  });
}

// ── 精算描画 ──────────────────────────────────────
function renderSettle() {
  const txs = monthTx();

  // 個人支出（精算対象：共用財布払いは除外）
  const gfExp  = txs.filter(t=>t.payer==='girlfriend'&&t.type==='expense').reduce((s,t)=>s+t.amount,0);
  const bfExp  = txs.filter(t=>t.payer==='boyfriend' &&t.type==='expense').reduce((s,t)=>s+t.amount,0);
  const jExp   = txs.filter(t=>t.payer==='joint'     &&t.type==='expense').reduce((s,t)=>s+t.amount,0);
  // 共用財布入金（振替→jointで管理、旧depositデータも合算）
  const gfDep  = txs.filter(t=>t.payer==='girlfriend'&&(t.type==='deposit'||(t.type==='transfer'&&t.transferTo==='joint'))).reduce((s,t)=>s+t.amount,0);
  const bfDep  = txs.filter(t=>t.payer==='boyfriend' &&(t.type==='deposit'||(t.type==='transfer'&&t.transferTo==='joint'))).reduce((s,t)=>s+t.amount,0);
  const jDep   = gfDep + bfDep;
  // 振替（人→人）による精算調整
  // bf→gf 振替: bf がすでに gf に支払い済み（gf の立替分を回収済み）
  const bfToGf = txs.filter(t=>t.type==='transfer'&&t.payer==='boyfriend' &&t.transferTo==='girlfriend').reduce((s,t)=>s+t.amount,0);
  const gfToBf = txs.filter(t=>t.type==='transfer'&&t.payer==='girlfriend'&&t.transferTo==='boyfriend' ).reduce((s,t)=>s+t.amount,0);
  // 共用財布からの出金（振替元=joint）
  const transferFromJoint = txs.filter(t=>t.type==='transfer'&&t.payer==='joint').reduce((s,t)=>s+t.amount,0);
  const jWit = transferFromJoint;

  // ── 精算計算（支出 + 共用財布への振替 − 共用財布からの振替）──
  // 共用財布への振替（gf/bf → joint）
  const gfToJoint = txs.filter(t=>t.type==='transfer'&&t.payer==='girlfriend'&&t.transferTo==='joint').reduce((s,t)=>s+t.amount,0);
  const bfToJoint = txs.filter(t=>t.type==='transfer'&&t.payer==='boyfriend' &&t.transferTo==='joint').reduce((s,t)=>s+t.amount,0);
  // 共用財布からの振替（joint → gf/bf）
  const jointToGf = txs.filter(t=>t.type==='transfer'&&t.payer==='joint'&&t.transferTo==='girlfriend').reduce((s,t)=>s+t.amount,0);
  const jointToBf = txs.filter(t=>t.type==='transfer'&&t.payer==='joint'&&t.transferTo==='boyfriend' ).reduce((s,t)=>s+t.amount,0);

  // 実際の負担額（支出 + 振替入金 − 振替出金）
  const gfActualPaid = gfExp + gfToJoint - jointToGf;
  const bfActualPaid = bfExp + bfToJoint - jointToBf;

  // 按分額（各トランザクションを日付対応の割合で計算）
  let gfShouldPay = 0, bfShouldPay = 0;

  // 個人支出
  txs.filter(t => t.type === 'expense' && (t.payer === 'girlfriend' || t.payer === 'boyfriend')).forEach(t => {
    const r = getRatioForDate(t.date);
    const rt = (Number(r.gfRatio)||1) + (Number(r.bfRatio)||1);
    gfShouldPay += t.amount * (Number(r.gfRatio)||1) / rt;
    bfShouldPay += t.amount * (Number(r.bfRatio)||1) / rt;
  });
  // 共用財布への振替（各自が割合に応じて負担すべき）
  txs.filter(t => t.type === 'transfer' && t.transferTo === 'joint' && t.payer !== 'joint').forEach(t => {
    const r = getRatioForDate(t.date);
    const rt = (Number(r.gfRatio)||1) + (Number(r.bfRatio)||1);
    gfShouldPay += t.amount * (Number(r.gfRatio)||1) / rt;
    bfShouldPay += t.amount * (Number(r.bfRatio)||1) / rt;
  });
  // 共用財布からの振替（割合に応じて受け取るべき額を差し引き）
  txs.filter(t => t.type === 'transfer' && t.payer === 'joint' && (t.transferTo === 'girlfriend' || t.transferTo === 'boyfriend')).forEach(t => {
    const r = getRatioForDate(t.date);
    const rt = (Number(r.gfRatio)||1) + (Number(r.bfRatio)||1);
    gfShouldPay -= t.amount * (Number(r.gfRatio)||1) / rt;
    bfShouldPay -= t.amount * (Number(r.bfRatio)||1) / rt;
  });
  // 共用財布払い個人支出（100%その人の負担）
  txs.filter(t => t.payer === 'joint' && t.type === 'expense' && t.beneficiary).forEach(t => {
    if (t.beneficiary === 'girlfriend') gfShouldPay += t.amount;
    else if (t.beneficiary === 'boyfriend') bfShouldPay += t.amount;
  });

  // 差額（正 = 払いすぎ＝未回収、負 = 未払い）
  const netBfToGf = bfToGf - gfToBf;
  const gfDiff = (gfActualPaid - gfShouldPay) - netBfToGf;
  const bfDiff = (bfActualPaid - bfShouldPay) + netBfToGf;

  // 割合ラベル
  const allSettleTxs = txs.filter(t =>
    (t.type === 'expense' && (t.payer === 'girlfriend' || t.payer === 'boyfriend')) ||
    (t.type === 'transfer' && (t.transferTo === 'joint' || t.payer === 'joint'))
  );
  const ratioKeys = [...new Set(allSettleTxs.map(t => { const r = getRatioForDate(t.date); return `${r.gfRatio}:${r.bfRatio}`; }))];
  const ratioLabel = ratioKeys.length === 0 ? '（取引なし）'
    : ratioKeys.length === 1
      ? (() => { const r = getRatioForDate(allSettleTxs[0].date); return `（${settings.gfName} ${r.gfRatio} : ${settings.bfName} ${r.bfRatio}）`; })()
      : '（複数の割合を適用）';

  // 内訳描画
  const bdEl = document.getElementById('breakdown-list');
  bdEl.innerHTML = `
    <div class="breakdown-item ratio-info-item">
      <div class="bd-avatar">⚖️</div>
      <div class="bd-info">
        <div class="bd-name">負担割合 ${ratioLabel}</div>
        <div class="bd-detail">
          ${settings.gfName} 本来負担: ${fmt(Math.round(gfShouldPay))} /
          ${settings.bfName} 本来負担: ${fmt(Math.round(bfShouldPay))}
        </div>
      </div>
    </div>
    <div class="breakdown-item">
      <div class="bd-info">
        <div class="bd-name">${settings.gfName}</div>
        <div class="bd-detail">
          支出 ${fmt(gfExp)}${gfToJoint>0?' / 財布入金 '+fmt(gfToJoint):''}${jointToGf>0?' / 財布出金 '+fmt(jointToGf):''}
          ${netBfToGf!==0?' / 振替受取 '+fmt(netBfToGf):''}
        </div>
      </div>
      <div class="bd-amount ${gfDiff>=0?'positive':'negative'}">
        ${gfDiff>=0?'△':'▲'}${fmt(Math.round(Math.abs(gfDiff)))}
        <div style="font-size:0.65rem;font-weight:400;color:var(--muted)">${gfDiff>=0?'未回収':'支払済超過'}</div>
      </div>
    </div>
    <div class="breakdown-item">
      <div class="bd-info">
        <div class="bd-name">${settings.bfName}</div>
        <div class="bd-detail">
          支出 ${fmt(bfExp)}${bfToJoint>0?' / 財布入金 '+fmt(bfToJoint):''}${jointToBf>0?' / 財布出金 '+fmt(jointToBf):''}
          ${netBfToGf!==0?' / 振替送金 '+fmt(netBfToGf):''}
        </div>
      </div>
      <div class="bd-amount ${bfDiff<=0?'negative':'positive'}">
        ${bfDiff<=0?'▽':'△'}${fmt(Math.round(Math.abs(bfDiff)))}
        <div style="font-size:0.65rem;font-weight:400;color:var(--muted)">${bfDiff<=0?'未払い':'払いすぎ'}</div>
      </div>
    </div>
  `;

  // ── 全期間の内訳 ──────────────────────────────────
  const allTx = transactions;
  const allGfExp     = allTx.filter(t=>t.payer==='girlfriend'&&t.type==='expense').reduce((s,t)=>s+t.amount,0);
  const allBfExp     = allTx.filter(t=>t.payer==='boyfriend' &&t.type==='expense').reduce((s,t)=>s+t.amount,0);
  const allGfToJoint = allTx.filter(t=>t.type==='transfer'&&t.payer==='girlfriend'&&t.transferTo==='joint').reduce((s,t)=>s+t.amount,0);
  const allBfToJoint = allTx.filter(t=>t.type==='transfer'&&t.payer==='boyfriend' &&t.transferTo==='joint').reduce((s,t)=>s+t.amount,0);
  const allJointToGf = allTx.filter(t=>t.type==='transfer'&&t.payer==='joint'&&t.transferTo==='girlfriend').reduce((s,t)=>s+t.amount,0);
  const allJointToBf = allTx.filter(t=>t.type==='transfer'&&t.payer==='joint'&&t.transferTo==='boyfriend' ).reduce((s,t)=>s+t.amount,0);
  const allGfActual  = allGfExp + allGfToJoint - allJointToGf;
  const allBfActual  = allBfExp + allBfToJoint - allJointToBf;

  let allGfShouldPay = 0, allBfShouldPay = 0;
  // 個人支出
  allTx.filter(t => t.type === 'expense' && (t.payer === 'girlfriend' || t.payer === 'boyfriend')).forEach(t => {
    const r = getRatioForDate(t.date);
    const rt = (Number(r.gfRatio)||1) + (Number(r.bfRatio)||1);
    allGfShouldPay += t.amount * (Number(r.gfRatio)||1) / rt;
    allBfShouldPay += t.amount * (Number(r.bfRatio)||1) / rt;
  });
  // 共用財布への振替
  allTx.filter(t => t.type === 'transfer' && t.transferTo === 'joint' && t.payer !== 'joint').forEach(t => {
    const r = getRatioForDate(t.date);
    const rt = (Number(r.gfRatio)||1) + (Number(r.bfRatio)||1);
    allGfShouldPay += t.amount * (Number(r.gfRatio)||1) / rt;
    allBfShouldPay += t.amount * (Number(r.bfRatio)||1) / rt;
  });
  // 共用財布からの振替
  allTx.filter(t => t.type === 'transfer' && t.payer === 'joint' && (t.transferTo === 'girlfriend' || t.transferTo === 'boyfriend')).forEach(t => {
    const r = getRatioForDate(t.date);
    const rt = (Number(r.gfRatio)||1) + (Number(r.bfRatio)||1);
    allGfShouldPay -= t.amount * (Number(r.gfRatio)||1) / rt;
    allBfShouldPay -= t.amount * (Number(r.bfRatio)||1) / rt;
  });
  // 共用財布払い個人支出（100%その人の負担）
  allTx.filter(t => t.payer === 'joint' && t.type === 'expense' && t.beneficiary).forEach(t => {
    if (t.beneficiary === 'girlfriend') allGfShouldPay += t.amount;
    else if (t.beneficiary === 'boyfriend') allBfShouldPay += t.amount;
  });

  const allBfToGf = allTx.filter(t=>t.type==='transfer'&&t.payer==='boyfriend' &&t.transferTo==='girlfriend').reduce((s,t)=>s+t.amount,0);
  const allGfToBf = allTx.filter(t=>t.type==='transfer'&&t.payer==='girlfriend'&&t.transferTo==='boyfriend' ).reduce((s,t)=>s+t.amount,0);
  const allNetBfToGf = allBfToGf - allGfToBf;
  const allGfDiff = (allGfActual - allGfShouldPay) - allNetBfToGf;
  const allBfDiff = (allBfActual - allBfShouldPay) + allNetBfToGf;

  const bdAllEl = document.getElementById('breakdown-list-all');
  bdAllEl.innerHTML = `
    <div class="breakdown-item">
      <div class="bd-info">
        <div class="bd-name">${settings.gfName}</div>
      </div>
      <div class="bd-amount ${allGfDiff>=0?'positive':'negative'}">
        ${allGfDiff>=0?'△':'▲'}${fmt(Math.round(Math.abs(allGfDiff)))}
        <div style="font-size:0.65rem;font-weight:400;color:var(--muted)">${allGfDiff>=0?'未回収':'支払済超過'}</div>
      </div>
    </div>
    <div class="breakdown-item">
      <div class="bd-info">
        <div class="bd-name">${settings.bfName}</div>
      </div>
      <div class="bd-amount ${allBfDiff<=0?'negative':'positive'}">
        ${allBfDiff<=0?'▽':'△'}${fmt(Math.round(Math.abs(allBfDiff)))}
        <div style="font-size:0.65rem;font-weight:400;color:var(--muted)">${allBfDiff<=0?'未払い':'払いすぎ'}</div>
      </div>
    </div>
  `;
}

// ── 全体再描画 ────────────────────────────────────
function renderAll() {
  renderHome();
  renderHistory();
  renderSettle();
}

// ── タブ切り替え ──────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ── 月ナビ ────────────────────────────────────────
document.getElementById('prev-month').addEventListener('click', () => {
  const d = new Date(viewMonth + '-01');
  d.setMonth(d.getMonth() - 1);
  viewMonth = d.toISOString().slice(0,7);
  renderAll();
});
document.getElementById('next-month').addEventListener('click', () => {
  const d = new Date(viewMonth + '-01');
  d.setMonth(d.getMonth() + 1);
  viewMonth = d.toISOString().slice(0,7);
  renderAll();
});

// ── モーダル ──────────────────────────────────────
const modalOverlay = document.getElementById('modal-overlay');

function openModal() {
  document.getElementById('input-amount').value = '';
  document.getElementById('input-note').value = '';
  document.getElementById('input-date').value = new Date().toISOString().slice(0,10);
  setType('expense');
  setPayer('girlfriend');
  setTransferTo('boyfriend');
  setBeneficiary('none');
  modalOverlay.classList.add('active');
  setTimeout(() => document.getElementById('input-amount').focus(), 300);
}

function closeModal() { modalOverlay.classList.remove('active'); }

function updateBeneficiaryVisibility() {
  const show = currentType === 'expense' && currentPayer === 'joint';
  document.getElementById('beneficiary-group').style.display = show ? 'block' : 'none';
  if (!show) setBeneficiary('none');
}

function setType(type) {
  currentType = type;
  document.querySelectorAll('.type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });

  const jointBtn       = document.getElementById('payer-joint-btn');
  const label          = document.getElementById('payer-group-label');
  const transferToGrp  = document.getElementById('transfer-to-group');
  const categoryGrp    = document.getElementById('category-group');

  if (type === 'transfer') {
    document.getElementById('payer-group').style.display = 'block';
    label.textContent        = '振替元';
    jointBtn.style.display   = '';
    transferToGrp.style.display = 'block';
    categoryGrp.style.display   = 'none';
  } else {
    document.getElementById('payer-group').style.display = 'block';
    label.textContent        = '支出元';
    jointBtn.style.display   = '';
    transferToGrp.style.display = 'none';
    categoryGrp.style.display   = 'block';
  }
  updateBeneficiaryVisibility();
}

function setPayer(payer) {
  currentPayer = payer;
  document.querySelectorAll('.payer-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.payer === payer);
  });
  updateBeneficiaryVisibility();
}

function setBeneficiary(ben) {
  currentBeneficiary = ben;
  document.querySelectorAll('.ben-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.ben === ben);
  });
}

function setTransferTo(to) {
  currentTransferTo = to;
  document.querySelectorAll('.transfer-to-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.to === to);
  });
}

document.getElementById('add-btn').addEventListener('click', openModal);
document.getElementById('btn-cancel').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });

document.querySelectorAll('.type-btn').forEach(btn => {
  btn.addEventListener('click', () => setType(btn.dataset.type));
});
document.querySelectorAll('.payer-btn').forEach(btn => {
  btn.addEventListener('click', () => setPayer(btn.dataset.payer));
});
document.querySelectorAll('.transfer-to-btn').forEach(btn => {
  btn.addEventListener('click', () => setTransferTo(btn.dataset.to));
});
document.querySelectorAll('.ben-btn').forEach(btn => {
  btn.addEventListener('click', () => setBeneficiary(btn.dataset.ben));
});

// ── 保存 ──────────────────────────────────────────
document.getElementById('btn-save').addEventListener('click', () => {
  const amount = parseInt(document.getElementById('input-amount').value);
  const date   = document.getElementById('input-date').value;
  const note   = document.getElementById('input-note').value.trim();
  const cat    = document.getElementById('input-category').value;

  if (!amount || amount <= 0) { alert('金額を入力してください'); return; }
  if (!date) { alert('日付を入力してください'); return; }

  if (currentType === 'transfer' && currentPayer === currentTransferTo) {
    alert('振替元と振替先が同じです');
    return;
  }

  const tx = {
    id: Date.now(),
    type: currentType,
    payer: currentPayer,
    amount,
    category: currentType === 'transfer' ? '振替' : cat,
    note,
    date
  };
  if (currentType === 'transfer') tx.transferTo = currentTransferTo;
  if (currentType === 'expense' && currentPayer === 'joint' && currentBeneficiary !== 'none') {
    tx.beneficiary = currentBeneficiary;
  }

  transactions.unshift(tx);

  save();
  renderAll();
  closeModal();
});

// ── 削除（履歴） ──────────────────────────────────
document.getElementById('history-tx-list').addEventListener('click', e => {
  const btn = e.target.closest('.tx-delete');
  if (btn && confirm('この取引を削除しますか？')) {
    transactions = transactions.filter(t => t.id !== Number(btn.dataset.id));
    save();
    renderAll();
  }
});

// ── フィルター ────────────────────────────────────
['filter-payer','filter-category','filter-type'].forEach(id => {
  document.getElementById(id).addEventListener('change', renderHistory);
});

// ── 設定 ──────────────────────────────────────────
const settingsOverlay = document.getElementById('settings-overlay');

document.getElementById('settings-btn').addEventListener('click', () => {
  document.getElementById('setting-gf-name').value = settings.gfName;
  document.getElementById('setting-bf-name').value = settings.bfName;
  document.getElementById('setting-ratio-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('setting-gf-ratio').value = '';
  document.getElementById('setting-bf-ratio').value = '';
  renderRatioHistory();
  settingsOverlay.classList.add('active');
});

document.getElementById('settings-cancel').addEventListener('click', () => {
  settingsOverlay.classList.remove('active');
});

settingsOverlay.addEventListener('click', e => {
  if (e.target === settingsOverlay) settingsOverlay.classList.remove('active');
});

document.getElementById('settings-save').addEventListener('click', () => {
  settings.gfName = document.getElementById('setting-gf-name').value.trim() || '彼女';
  settings.bfName = document.getElementById('setting-bf-name').value.trim() || '彼氏';

  const gfR  = parseFloat(document.getElementById('setting-gf-ratio').value);
  const bfR  = parseFloat(document.getElementById('setting-bf-ratio').value);
  const date = document.getElementById('setting-ratio-date').value;

  // 割合と日付が両方入力されている場合のみ追加
  if (gfR > 0 && bfR > 0 && date) {
    // 同じ日付のエントリがあれば上書き
    settings.ratioHistory = settings.ratioHistory.filter(r => r.from !== date);
    settings.ratioHistory.push({ from: date, gfRatio: gfR, bfRatio: bfR });
    // 入力をクリア
    document.getElementById('setting-gf-ratio').value = '';
    document.getElementById('setting-bf-ratio').value = '';
    document.getElementById('setting-ratio-date').value = '';
  }

  save();
  applyNames();
  renderAll();
  settingsOverlay.classList.remove('active');
});

// ── ログアウト ────────────────────────────────────
document.getElementById('logout-btn').addEventListener('click', () => {
  if (confirm('ログアウトしますか？')) {
    sessionStorage.removeItem('kakeibo_auth');
    location.replace('login.html');
  }
});

// ── 初期化 ────────────────────────────────────────
applyNames();
renderAll();
