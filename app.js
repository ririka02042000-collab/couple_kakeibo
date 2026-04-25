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
  expense: '支出', deposit: '貯金入金', transfer: '振替', advance: '立替'
};

// ── 状態 ──────────────────────────────────────────
let transactions = JSON.parse(localStorage.getItem('couple_kakeibo') || '[]');
let settings = JSON.parse(localStorage.getItem('couple_settings') || '{"gfName":"彼女","bfName":"彼氏","ratioHistory":[{"from":"1970-01-01","gfRatio":10000,"bfRatio":12000}]}');
// 旧フォーマットからの移行
if (!settings.ratioHistory) {
  settings.ratioHistory = [{ from: '1970-01-01', gfRatio: settings.gfRatio || 1, bfRatio: settings.bfRatio || 1 }];
}

// 年別取引データ（遅延読み込み用）
let transactionsByYear = {};          // { '2026': [tx,...], '2025': [tx,...] }
transactions.forEach(tx => {
  const y = tx.date?.slice(0,4); if (!y) return;
  if (!transactionsByYear[y]) transactionsByYear[y] = [];
  transactionsByYear[y].push(tx);
});
let loadedYears    = new Set();       // GitHub から取得済みの年
let ghYearShas     = {};              // { '2026': 'sha...', ... }
let availableYears = [];              // GitHub に存在する年一覧
let ghSetSha       = null;
let ghSyncTimers   = {};              // { year: timerID }
let ghSyncing      = false;           // syncFromGitHub 実行中フラグ（多重起動防止）
// 削除済みID集合：同期時にリモートから復活させないために記録
let deletedIds = new Set(JSON.parse(localStorage.getItem('kakeibo_deleted') || '[]'));
function saveDeletedIds() {
  localStorage.setItem('kakeibo_deleted', JSON.stringify([...deletedIds]));
}

let currentType        = 'expense';
let currentPayer       = 'joint';
let currentTransferTo  = 'girlfriend';
let currentBeneficiary = 'none';
let currentAdvanceTo   = 'girlfriend';

// ローカル時刻で YYYY-MM を返す（UTC変換による月ずれ防止）
function localYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
let viewMonth        = localYearMonth(); // "YYYY-MM"
let settleViewMonth  = localYearMonth(); // "YYYY-MM"（精算タブ独立）
let historyViewMonth = localYearMonth(); // "YYYY-MM"
let historyShowAll   = false; // 全期間表示フラグ（起動時は当月）
let editingTxId      = null;  // 編集中の取引ID（nullなら新規追加）

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
// affectedYear: 変更があった年（取引の追加・削除時）。設定のみの場合は null
const save = (affectedYear) => {
  localStorage.setItem('couple_kakeibo', JSON.stringify(transactions));
  localStorage.setItem('couple_settings', JSON.stringify(settings));
  if (affectedYear) scheduleSyncYearToGitHub(affectedYear);
  scheduleSyncSettingsToGitHub();
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
  const benGf = document.getElementById('ben-gf-label');
  const benBf = document.getElementById('ben-bf-label');
  if (benGf) benGf.textContent = settings.gfName;
  if (benBf) benBf.textContent = settings.bfName;
  document.getElementById('advance-to-gf-label').textContent = settings.gfName;
  document.getElementById('advance-to-bf-label').textContent = settings.bfName;

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
  document.getElementById('current-month-input').value = viewMonth;

  const txs = monthTx();

  // 共用財布による個人立て替え額（月次）※expense+beneficiary と advance 両方
  const jointPersonalForGf = txs.filter(t => t.payer === 'joint' && t.beneficiary === 'girlfriend' && (t.type === 'expense' || t.type === 'advance')).reduce((s,t) => s+t.amount, 0);
  const jointPersonalForBf = txs.filter(t => t.payer === 'joint' && t.beneficiary === 'boyfriend'  && (t.type === 'expense' || t.type === 'advance')).reduce((s,t) => s+t.amount, 0);

  // 彼女支出（支出 + 振替送金 − 振替受取 − 共用財布による立て替え）
  const gfExp        = txs.filter(t => t.payer === 'girlfriend' && t.type === 'expense').reduce((s,t) => s+t.amount, 0);
  const gfTransferOut = txs.filter(t => t.payer === 'girlfriend' && t.type === 'transfer').reduce((s,t) => s+t.amount, 0);
  const gfTransferIn  = txs.filter(t => t.transferTo === 'girlfriend' && t.type === 'transfer').reduce((s,t) => s+t.amount, 0);
  const gfTotal = gfExp + gfTransferOut - gfTransferIn - jointPersonalForGf;

  // 彼氏支出（支出 + 振替送金 − 振替受取 − 共用財布による立て替え）
  const bfExp        = txs.filter(t => t.payer === 'boyfriend' && t.type === 'expense').reduce((s,t) => s+t.amount, 0);
  const bfTransferOut = txs.filter(t => t.payer === 'boyfriend' && t.type === 'transfer').reduce((s,t) => s+t.amount, 0);
  const bfTransferIn  = txs.filter(t => t.transferTo === 'boyfriend' && t.type === 'transfer').reduce((s,t) => s+t.amount, 0);
  const bfTotal = bfExp + bfTransferOut - bfTransferIn - jointPersonalForBf;

  // 共用財布残高（全期間）※個人立て替えは除外
  const allJointIn  = transactions.filter(t => t.type === 'deposit' || (t.type === 'transfer' && t.transferTo === 'joint')).reduce((s,t)=>s+t.amount,0);
  const allJointOut = transactions.filter(t =>
    (t.type === 'transfer' && t.payer === 'joint') ||
    (t.payer === 'joint' && (t.type === 'expense' || t.type === 'advance') && !t.beneficiary) ||
    (t.payer === 'joint' && t.type === 'advance' && t.beneficiary)
  ).reduce((s,t)=>s+t.amount,0);
  // その月の支出・入金
  // 共用財布直接支出 + 振替出金
  const monthJointExpOnly  = txs.filter(t => t.payer === 'joint' && (t.type === 'expense' || t.type === 'advance') && !t.beneficiary).reduce((s,t)=>s+t.amount,0);
  const monthJointTransOut = txs.filter(t => t.payer === 'joint' && t.type === 'transfer').reduce((s,t)=>s+t.amount,0);
  // 彼女・彼氏の個人支出も家計全体の支出として加算
  const monthPersonalExp = txs.filter(t => (t.payer === 'girlfriend' || t.payer === 'boyfriend') && t.type === 'expense').reduce((s,t)=>s+t.amount,0);
  const monthJointExp = monthJointExpOnly + monthJointTransOut + monthPersonalExp;
  // 入金：振替入金 + 個人支出分（個人が自ら立て替えた入金として扱う）
  const monthJointInRaw  = txs.filter(t => t.type === 'deposit' || (t.type === 'transfer' && t.transferTo === 'joint')).reduce((s,t)=>s+t.amount,0);
  const monthJointAdvance = txs.filter(t => t.type === 'advance' && t.payer === 'joint').reduce((s,t)=>s+t.amount,0);
  const monthJointIn = monthJointInRaw - monthJointAdvance + monthPersonalExp;

  // 入金済・立替の計算（精算と同様）
  const gfToJointH  = txs.filter(t=>t.type==='transfer'&&t.payer==='girlfriend'&&t.transferTo==='joint').reduce((s,t)=>s+t.amount,0);
  const bfToJointH  = txs.filter(t=>t.type==='transfer'&&t.payer==='boyfriend' &&t.transferTo==='joint').reduce((s,t)=>s+t.amount,0);
  const jointToGfH  = txs.filter(t=>t.type==='transfer'&&t.payer==='joint'&&t.transferTo==='girlfriend').reduce((s,t)=>s+t.amount,0);
  const jointToBfH  = txs.filter(t=>t.type==='transfer'&&t.payer==='joint'&&t.transferTo==='boyfriend' ).reduce((s,t)=>s+t.amount,0);
  const gfAdvForBfH = txs.filter(t=>t.type==='advance'&&t.payer==='girlfriend'&&t.beneficiary==='boyfriend').reduce((s,t)=>s+t.amount,0);
  const bfAdvForGfH = txs.filter(t=>t.type==='advance'&&t.payer==='boyfriend' &&t.beneficiary==='girlfriend').reduce((s,t)=>s+t.amount,0);
  const netGfAdvH   = gfAdvForBfH - bfAdvForGfH;
  const netBfAdvH   = bfAdvForGfH - gfAdvForBfH;
  const gfDepBaseH  = gfExp + gfToJointH - jointToGfH - jointPersonalForGf;
  const bfDepBaseH  = bfExp + bfToJointH - jointToBfH - jointPersonalForBf;

  const gfAdvLineH = netGfAdvH !== 0
    ? `<div style="font-size:0.7rem;margin-top:3px;color:#a78bfa">${netGfAdvH > 0 ? '立替 ＋' : '立替 －'}${fmt(Math.abs(netGfAdvH))}</div>`
    : '';
  const bfAdvLineH = netBfAdvH !== 0
    ? `<div style="font-size:0.7rem;margin-top:3px;color:#a78bfa">${netBfAdvH > 0 ? '立替 ＋' : '立替 －'}${fmt(Math.abs(netBfAdvH))}</div>`
    : '';
  document.getElementById('gf-amount').innerHTML = `${fmt(gfDepBaseH)}${gfAdvLineH}`;
  document.getElementById('bf-amount').innerHTML = `${fmt(bfDepBaseH)}${bfAdvLineH}`;
  const gfLabelEl = document.querySelector('.person-card.girlfriend .person-label');
  const bfLabelEl = document.querySelector('.person-card.boyfriend .person-label');
  if (gfLabelEl) gfLabelEl.textContent = '入金済';
  if (bfLabelEl) bfLabelEl.textContent = '入金済';
  document.getElementById('joint-expense').textContent  = fmt(monthJointExp);
  document.getElementById('joint-in').textContent       = fmt(monthJointIn);

  // カテゴリ集計（支出のみ）
  const expTxs = txs.filter(t => t.type === 'expense');
  const catMap = {};
  expTxs.forEach(t => { catMap[t.category] = (catMap[t.category]||0) + t.amount; });
  const catSorted = Object.entries(catMap).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const maxCat = catSorted[0]?.[1] || 1;

  const chartEl = document.getElementById('category-chart');
  if (catSorted.length) {
    chartEl.innerHTML = catSorted.map(([cat, amt], idx) => {
      const catTxs = expTxs
        .filter(t => t.category === cat)
        .sort((a,b) => b.date.localeCompare(a.date) || b.id - a.id);
      const detailHTML = catTxs.map(t => {
        const pName = t.payer === 'girlfriend' ? settings.gfName
                    : t.payer === 'boyfriend'  ? settings.bfName : '共用財布';
        const pi = PAYER_INFO[t.payer] || PAYER_INFO.joint;
        return `<div class="cat-detail-item">
          <span class="cat-di-payer ${pi.class}">${pi.emoji}</span>
          <div class="cat-di-info">
            <div class="cat-di-note">${t.note ? escHtml(t.note) : escHtml(cat)}</div>
            <div class="cat-di-meta">${fmtDate(t.date)} · ${escHtml(pName)}</div>
          </div>
          <span class="cat-di-amount">${fmt(t.amount)}</span>
        </div>`;
      }).join('');
      return `
        <div class="category-row" data-idx="${idx}">
          <span class="cat-icon">${CATEGORY_ICONS[cat]||'📦'}</span>
          <span class="cat-name">${escHtml(cat)}</span>
          <div class="cat-bar-wrap">
            <div class="cat-bar" style="width:${(amt/maxCat*100).toFixed(1)}%"></div>
          </div>
          <span class="cat-amount">${fmt(amt)}</span>
          <span class="cat-expand-arrow">▶</span>
        </div>
        <div class="cat-detail" id="cat-detail-${idx}" style="display:none">${detailHTML}</div>
      `;
    }).join('');

    // クリックで詳細アコーディオン
    chartEl.querySelectorAll('.category-row').forEach(row => {
      row.addEventListener('click', () => {
        const idx    = row.dataset.idx;
        const detail = document.getElementById(`cat-detail-${idx}`);
        const arrow  = row.querySelector('.cat-expand-arrow');
        const isOpen = row.classList.contains('cat-expanded');
        row.classList.toggle('cat-expanded', !isOpen);
        detail.style.display = isOpen ? 'none' : 'block';
        if (arrow) arrow.textContent = isOpen ? '▶' : '▼';
      });
    });
  } else {
    chartEl.innerHTML = '<p class="empty-chart">支出データなし</p>';
  }

  // 最近5件
  const recent = txs.slice().sort((a,b)=>b.date.localeCompare(a.date)||b.id-a.id).slice(0,5);
  renderTxList('home-tx-list', recent, false);
}

// ── 履歴描画 ──────────────────────────────────────
function renderHistory() {
  const payerF  = document.getElementById('filter-payer').value;
  const catF    = document.getElementById('filter-category').value;
  const typeF   = document.getElementById('filter-type').value;

  // 月ナビ更新
  const allBtn    = document.getElementById('history-all-btn');
  const monthInput = document.getElementById('history-month-input');
  if (historyShowAll) {
    allBtn.classList.add('active');
    monthInput.style.visibility = 'hidden';
  } else {
    allBtn.classList.remove('active');
    monthInput.style.visibility = 'visible';
    monthInput.value = historyViewMonth;
  }

  let list = transactions.slice();
  if (!historyShowAll) list = list.filter(t => t.date.startsWith(historyViewMonth));
  if (payerF) list = list.filter(t => t.payer === payerF);
  if (catF)   list = list.filter(t => t.category === catF);
  if (typeF)  list = list.filter(t => t.type === typeF);
  list.sort((a,b) => b.date.localeCompare(a.date) || b.id - a.id);

  renderTxList('history-tx-list', list, true);
}

// ── 取引1件のHTML生成 ──────────────────────────────
function buildTxItem(t, showDelete) {
  const pi = PAYER_INFO[t.payer] || PAYER_INFO.joint;
  const payerName = t.payer === 'girlfriend' ? settings.gfName
                  : t.payer === 'boyfriend'  ? settings.bfName : '共用財布';

  let categoryText, metaText;
  if (t.type === 'transfer') {
    const toName = t.transferTo === 'girlfriend' ? settings.gfName
                 : t.transferTo === 'boyfriend'  ? settings.bfName : '共用財布';
    categoryText = `${payerName} → ${toName}`;
    metaText = t.note ? escHtml(t.note) : '';
  } else if (t.type === 'advance') {
    const toName = t.beneficiary === 'girlfriend' ? settings.gfName : settings.bfName;
    categoryText = `${t.category || 'その他'} (${toName}個人)`;
    metaText = [payerName, t.note ? escHtml(t.note) : ''].filter(Boolean).join(' · ');
  } else {
    categoryText = t.category || TYPE_LABELS[t.type];
    metaText = [payerName, t.note ? escHtml(t.note) : ''].filter(Boolean).join(' · ');
  }

  const item = document.createElement('div');
  item.className = 'tx-item';
  item.innerHTML = `
    <div class="tx-payer-badge ${pi.class}">${pi.emoji}</div>
    <div class="tx-info">
      <div class="tx-category">${categoryText}</div>
      ${metaText ? `<div class="tx-meta">${metaText}</div>` : ''}
    </div>
    <div class="tx-right">
      <div class="tx-type-badge ${t.type}">${t.type === 'transfer' ? '振替' : t.type === 'advance' ? '立替' : '支出'}</div>
      <div class="tx-amount ${t.type}">${sign(t.type, t.amount)}</div>
      ${showDelete ? `<div class="tx-actions"><button class="tx-edit" data-id="${t.id}" title="編集">✏</button><button class="tx-delete" data-id="${t.id}" title="削除">✕</button></div>` : ''}
    </div>
  `;
  return item;
}

// ── 取引リスト共通描画（日付グループ化） ───────────
function renderTxList(containerId, list, showDelete) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';

  if (!list.length) {
    el.innerHTML = '<p class="empty-msg">取引がありません</p>';
    return;
  }

  // 日付でグループ化
  const groups = {};
  list.forEach(t => {
    if (!groups[t.date]) groups[t.date] = [];
    groups[t.date].push(t);
  });

  // 日付降順で表示
  Object.keys(groups).sort((a,b) => b.localeCompare(a)).forEach(date => {
    const dt = new Date(date + 'T00:00:00');
    const dateLabel = `${dt.getMonth()+1}月${dt.getDate()}日`;

    const header = document.createElement('div');
    header.className = 'tx-date-header';
    header.textContent = dateLabel;
    el.appendChild(header);

    const group = document.createElement('div');
    group.className = 'tx-group';
    groups[date].sort((a,b) => b.id - a.id).forEach(t => {
      group.appendChild(buildTxItem(t, showDelete));
    });
    el.appendChild(group);
  });
}

// ── 精算差額計算ヘルパー ─────────────────────────────
function calcSettlementDiff(txArray) {
  const gfExp = txArray.filter(t=>t.payer==='girlfriend'&&t.type==='expense').reduce((s,t)=>s+t.amount,0);
  const bfExp = txArray.filter(t=>t.payer==='boyfriend' &&t.type==='expense').reduce((s,t)=>s+t.amount,0);
  const gfToJoint = txArray.filter(t=>t.type==='transfer'&&t.payer==='girlfriend'&&t.transferTo==='joint').reduce((s,t)=>s+t.amount,0);
  const bfToJoint = txArray.filter(t=>t.type==='transfer'&&t.payer==='boyfriend' &&t.transferTo==='joint').reduce((s,t)=>s+t.amount,0);
  const jointToGf = txArray.filter(t=>t.type==='transfer'&&t.payer==='joint'&&t.transferTo==='girlfriend').reduce((s,t)=>s+t.amount,0);
  const jointToBf = txArray.filter(t=>t.type==='transfer'&&t.payer==='joint'&&t.transferTo==='boyfriend' ).reduce((s,t)=>s+t.amount,0);
  const gfAdvancePaid = txArray.filter(t=>t.type==='advance'&&t.payer==='girlfriend').reduce((s,t)=>s+t.amount,0);
  const bfAdvancePaid = txArray.filter(t=>t.type==='advance'&&t.payer==='boyfriend' ).reduce((s,t)=>s+t.amount,0);
  const gfActual = gfExp + gfToJoint - jointToGf + gfAdvancePaid;
  const bfActual = bfExp + bfToJoint - jointToBf + bfAdvancePaid;

  let gfShouldPay = 0, bfShouldPay = 0;
  txArray.filter(t=>t.type==='expense'&&(t.payer==='girlfriend'||t.payer==='boyfriend')&&!t.beneficiary).forEach(t=>{
    const r = getRatioForDate(t.date);
    const rt = (Number(r.gfRatio)||1) + (Number(r.bfRatio)||1);
    gfShouldPay += t.amount * (Number(r.gfRatio)||1) / rt;
    bfShouldPay += t.amount * (Number(r.bfRatio)||1) / rt;
  });
  txArray.filter(t=>t.type==='transfer'&&t.transferTo==='joint'&&t.payer!=='joint').forEach(t=>{
    const r = getRatioForDate(t.date);
    const rt = (Number(r.gfRatio)||1) + (Number(r.bfRatio)||1);
    gfShouldPay += t.amount * (Number(r.gfRatio)||1) / rt;
    bfShouldPay += t.amount * (Number(r.bfRatio)||1) / rt;
  });
  txArray.filter(t=>t.type==='transfer'&&t.payer==='joint'&&(t.transferTo==='girlfriend'||t.transferTo==='boyfriend')).forEach(t=>{
    const r = getRatioForDate(t.date);
    const rt = (Number(r.gfRatio)||1) + (Number(r.bfRatio)||1);
    gfShouldPay -= t.amount * (Number(r.gfRatio)||1) / rt;
    bfShouldPay -= t.amount * (Number(r.bfRatio)||1) / rt;
  });
  txArray.filter(t=>t.beneficiary&&(t.type==='expense'||t.type==='advance')&&t.payer!=='joint').forEach(t=>{
    if (t.beneficiary==='girlfriend') gfShouldPay += t.amount;
    else if (t.beneficiary==='boyfriend') bfShouldPay += t.amount;
  });

  const bfToGf = txArray.filter(t=>t.type==='transfer'&&t.payer==='boyfriend' &&t.transferTo==='girlfriend').reduce((s,t)=>s+t.amount,0);
  const gfToBf = txArray.filter(t=>t.type==='transfer'&&t.payer==='girlfriend'&&t.transferTo==='boyfriend' ).reduce((s,t)=>s+t.amount,0);
  const netBfToGf = bfToGf - gfToBf;
  const gfDiff = (gfActual - gfShouldPay) - netBfToGf;
  const bfDiff = (bfActual - bfShouldPay) + netBfToGf;
  return { gfDiff, bfDiff, gfActual, bfActual };
}

// ── 精算描画 ──────────────────────────────────────
function renderSettle() {
  // 月入力欄を同期
  const settleMonthInput = document.getElementById('settle-month-input');
  if (settleMonthInput) settleMonthInput.value = settleViewMonth;

  // 見出しを動的更新（当月なら「今月の内訳」、それ以外は「YYYY年M月の内訳」）
  const titleEl = document.getElementById('settle-month-title');
  if (titleEl) {
    const [y, m] = settleViewMonth.split('-');
    const isCurrentMonth = settleViewMonth === localYearMonth();
    titleEl.textContent = isCurrentMonth ? '今月の内訳' : `${y}年${parseInt(m)}月の内訳`;
  }

  const txs = transactions.filter(t => t.date.startsWith(settleViewMonth));

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

  // 立替額
  const gfAdvForBf = txs.filter(t => t.type === 'advance' && t.payer === 'girlfriend' && t.beneficiary === 'boyfriend').reduce((s,t) => s+t.amount, 0);
  const bfAdvForGf = txs.filter(t => t.type === 'advance' && t.payer === 'boyfriend'  && t.beneficiary === 'girlfriend').reduce((s,t) => s+t.amount, 0);
  const netGfAdv = gfAdvForBf - bfAdvForGf;
  const netBfAdv = bfAdvForGf - gfAdvForBf;

  // 共用財布が個人費用を立替えた額（個人支出）
  const jointPersonalForGf = txs.filter(t => t.payer === 'joint' && t.beneficiary === 'girlfriend' && (t.type === 'expense' || t.type === 'advance')).reduce((s,t) => s+t.amount, 0);
  const jointPersonalForBf = txs.filter(t => t.payer === 'joint' && t.beneficiary === 'boyfriend'  && (t.type === 'expense' || t.type === 'advance')).reduce((s,t) => s+t.amount, 0);

  // 支出 = 個人支出 + 共用財布への振替
  const gfExpTotal = gfExp + gfToJoint;
  const bfExpTotal = bfExp + bfToJoint;

  // 入金済 = 支出 - 返金 - 個人支出
  const gfDepBaseVal = gfExpTotal - jointToGf - jointPersonalForGf;
  const bfDepBaseVal = bfExpTotal - jointToBf - jointPersonalForBf;

  // 本来負担額 = (gf入金済 + bf入金済) × 割合
  const r = getRatioForDate(settleViewMonth + '-01');
  const rt = (Number(r.gfRatio)||1) + (Number(r.bfRatio)||1);
  const sharedTotal = gfDepBaseVal + bfDepBaseVal;
  const gfShouldPay = sharedTotal * (Number(r.gfRatio)||1) / rt;
  const bfShouldPay = sharedTotal * (Number(r.bfRatio)||1) / rt;

  // 合計 = 支出 - 返金 - 本来負担 + 立替 - 個人支出
  const gfDiff = gfExpTotal - jointToGf - gfShouldPay + netGfAdv - jointPersonalForGf;
  const bfDiff = bfExpTotal - jointToBf - bfShouldPay + netBfAdv - jointPersonalForBf;

  // 入金額: 入金済 + 立替（net）
  const gfEffDep = gfDepBaseVal + netGfAdv;
  const bfEffDep = bfDepBaseVal + netBfAdv;
  const gfDepRatio  = Number(r.gfRatio) || 0;
  const bfDepRatio  = Number(r.bfRatio) || 0;
  let depMultiplier = 1;
  while (
    gfDepRatio > 0 && bfDepRatio > 0 &&
    (gfEffDep > gfDepRatio * depMultiplier || bfEffDep > bfDepRatio * depMultiplier)
  ) { depMultiplier++; }
  const gfDepTarget = gfDepRatio * depMultiplier;
  const bfDepTarget = bfDepRatio * depMultiplier;
  const gfDepRemain = Math.max(0, gfDepTarget - gfEffDep);
  const bfDepRemain = Math.max(0, bfDepTarget - bfEffDep);

  // 割合ラベル
  const ratioLabel = `（${settings.gfName} ${r.gfRatio} : ${settings.bfName} ${r.bfRatio}）`;

  // 詳細: 支出 / 返金 / 立替
  const fmtAdv = v => v >= 0 ? fmt(v) : `-${fmt(-v)}`;
  const gfDetailParts = [];
  if (gfExpTotal > 0) gfDetailParts.push(`支出 ${fmt(gfExpTotal)}`);
  if (jointToGf > 0)  gfDetailParts.push(`返金 -${fmt(jointToGf)}`);
  if (netGfAdv !== 0) gfDetailParts.push(`立替 ${fmtAdv(netGfAdv)}`);

  const bfDetailParts = [];
  if (bfExpTotal > 0) bfDetailParts.push(`支出 ${fmt(bfExpTotal)}`);
  if (jointToBf > 0)  bfDetailParts.push(`返金 -${fmt(jointToBf)}`);
  if (netBfAdv !== 0) bfDetailParts.push(`立替 ${fmtAdv(netBfAdv)}`);

  // 入金額表示: 入金済 ¥X + 立替 ¥Y ／ ¥Z → あと ¥W
  const fmtDepLine = (base, adv, target, remain) => {
    const advStr = adv !== 0 ? ` + 立替 ${fmtAdv(adv)}` : '';
    const remStr = remain > 0
      ? `→ <b>あと ${fmt(remain)}</b>`
      : `→ <b class="deposit-done">達成 ✓</b>`;
    return `入金済 ${fmt(base)}${advStr} ／ ${fmt(target)} ${remStr}`;
  };

  // 内訳描画
  const bdEl = document.getElementById('breakdown-list');
  bdEl.innerHTML = `
    <div class="breakdown-item deposit-target-item">
      <div class="bd-info">
        <div class="bd-name">💳 入金額</div>
        <div class="bd-detail" style="margin-top:4px">
          ${settings.gfName}：${fmtDepLine(gfDepBaseVal, netGfAdv, gfDepTarget, gfDepRemain)}
        </div>
        <div class="bd-detail" style="margin-top:4px">
          ${settings.bfName}：${fmtDepLine(bfDepBaseVal, netBfAdv, bfDepTarget, bfDepRemain)}
        </div>
      </div>
    </div>
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
        <div class="bd-detail">${gfDetailParts.join(' / ') || '取引なし'}</div>
      </div>
      <div class="bd-amount ${gfDiff>=0?'positive':'negative'}">
        ${gfDiff>=0?'△':'▽'}${fmt(Math.round(Math.abs(gfDiff)))}
        <div style="font-size:0.65rem;font-weight:400;color:var(--muted)">${gfDiff>=0?'貰う':'払う'}</div>
      </div>
    </div>
    <div class="breakdown-item">
      <div class="bd-info">
        <div class="bd-name">${settings.bfName}</div>
        <div class="bd-detail">${bfDetailParts.join(' / ') || '取引なし'}</div>
      </div>
      <div class="bd-amount ${bfDiff<=0?'negative':'positive'}">
        ${bfDiff<=0?'▽':'△'}${fmt(Math.round(Math.abs(bfDiff)))}
        <div style="font-size:0.65rem;font-weight:400;color:var(--muted)">${bfDiff<=0?'払う':'貰う'}</div>
      </div>
    </div>
  `;

  // ── 全期間の内訳 ──────────────────────────────────
  // 現在の割合開始日を取得
  const sortedRatioHistory = [...(settings.ratioHistory || [])].sort((a,b) => a.from.localeCompare(b.from));
  const currentRatioEntry  = sortedRatioHistory.length > 0 ? sortedRatioHistory[sortedRatioHistory.length - 1] : null;
  const currentRatioStart  = currentRatioEntry ? currentRatioEntry.from : null;

  // 割合が複数ある場合のみ、現在の割合開始日で絞り込む
  const hasMultipleRatios = sortedRatioHistory.length > 1;

  // 全期間タイトルを動的更新（割合変更がある場合のみ「以降」表示）
  const allTitleEl = document.getElementById('settle-all-title');
  if (allTitleEl) {
    if (hasMultipleRatios && currentRatioStart) {
      const [ay, am] = currentRatioStart.slice(0,7).split('-');
      allTitleEl.textContent = `${ay}年${parseInt(am)}月以降の内訳`;
    } else {
      allTitleEl.textContent = '全期間の内訳';
    }
  }

  // 現在の割合開始日以降のみを全期間計算対象とする（割合が複数ある場合のみ絞り込み）
  const allTx  = (hasMultipleRatios && currentRatioStart) ? transactions.filter(t => t.date >= currentRatioStart) : transactions;
  // 割合変更前の取引（割合が複数ある場合のみ）
  const prevTx = (hasMultipleRatios && currentRatioStart) ? transactions.filter(t => t.date < currentRatioStart) : [];

  // 割合変更前の精算カード
  let prevSettleHtml = '';
  if (prevTx.length > 0) {
    const { gfDiff: prevGfDiff, gfActual: prevGfActual, bfActual: prevBfActual } = calcSettlementDiff(prevTx);
    const prevAmt        = Math.round(Math.abs(prevGfDiff));
    const prevActualDiff = Math.round(Math.abs(prevGfActual - prevBfActual));
    if (prevAmt > 0 || prevActualDiff > 0) {
      // gfDiff > 0 → gfが多く払っている(overpayer)、bfが少ない(underpayer)
      const overpayer  = prevGfDiff >= 0 ? settings.gfName : settings.bfName;
      const underpayer = prevGfDiff >= 0 ? settings.bfName : settings.gfName;
      const lines = [];
      if (prevAmt > 0)
        lines.push(`${underpayer}は${overpayer}に ${fmt(prevAmt)} 払う`);
      if (prevActualDiff > 0)
        lines.push(`${underpayer}は ${fmt(prevActualDiff)} 入金`);
      if (prevActualDiff > 0)
        lines.push(`${overpayer}は ${fmt(prevActualDiff)} 返金`);
      prevSettleHtml = `
    <div class="breakdown-item prev-settle-item">
      <div class="bd-info">
        <div class="bd-name">🔄 割合変更前の精算</div>
        ${lines.map(l => `<div class="bd-detail">${l}</div>`).join('')}
      </div>
    </div>`;
    }
  }
  const allGfExp     = allTx.filter(t=>t.payer==='girlfriend'&&t.type==='expense').reduce((s,t)=>s+t.amount,0);
  const allBfExp     = allTx.filter(t=>t.payer==='boyfriend' &&t.type==='expense').reduce((s,t)=>s+t.amount,0);
  const allGfToJoint = allTx.filter(t=>t.type==='transfer'&&t.payer==='girlfriend'&&t.transferTo==='joint').reduce((s,t)=>s+t.amount,0);
  const allBfToJoint = allTx.filter(t=>t.type==='transfer'&&t.payer==='boyfriend' &&t.transferTo==='joint').reduce((s,t)=>s+t.amount,0);
  const allJointToGf = allTx.filter(t=>t.type==='transfer'&&t.payer==='joint'&&t.transferTo==='girlfriend').reduce((s,t)=>s+t.amount,0);
  const allJointToBf = allTx.filter(t=>t.type==='transfer'&&t.payer==='joint'&&t.transferTo==='boyfriend' ).reduce((s,t)=>s+t.amount,0);
  // 全期間計算（月次と同様のロジック）
  const allGfDep2 = allTx.filter(t=>t.payer==='girlfriend'&&(t.type==='deposit'||(t.type==='transfer'&&t.transferTo==='joint'))).reduce((s,t)=>s+t.amount,0);
  const allBfDep2 = allTx.filter(t=>t.payer==='boyfriend' &&(t.type==='deposit'||(t.type==='transfer'&&t.transferTo==='joint'))).reduce((s,t)=>s+t.amount,0);
  const allJDep   = allGfDep2 + allBfDep2;

  const allGfAdvForBf = allTx.filter(t => t.type === 'advance' && t.payer === 'girlfriend' && t.beneficiary === 'boyfriend').reduce((s,t) => s+t.amount, 0);
  const allBfAdvForGf = allTx.filter(t => t.type === 'advance' && t.payer === 'boyfriend'  && t.beneficiary === 'girlfriend').reduce((s,t) => s+t.amount, 0);
  const allNetGfAdv   = allGfAdvForBf - allBfAdvForGf;
  const allNetBfAdv   = allBfAdvForGf - allGfAdvForBf;

  const allJointPersonalForGf = allTx.filter(t => t.payer === 'joint' && t.beneficiary === 'girlfriend' && (t.type === 'expense' || t.type === 'advance')).reduce((s,t) => s+t.amount, 0);
  const allJointPersonalForBf = allTx.filter(t => t.payer === 'joint' && t.beneficiary === 'boyfriend'  && (t.type === 'expense' || t.type === 'advance')).reduce((s,t) => s+t.amount, 0);

  const allGfExpTotal = allGfExp + allGfToJoint;
  const allBfExpTotal = allBfExp + allBfToJoint;

  // 入金済 = 支出 - 返金 - 個人支出
  const allGfDepBaseVal = allGfExpTotal - allJointToGf - allJointPersonalForGf;
  const allBfDepBaseVal = allBfExpTotal - allJointToBf - allJointPersonalForBf;

  // 本来負担額 = (gf入金済 + bf入金済) × 割合
  const allR  = getRatioForDate(new Date().toISOString().slice(0,10));
  const allRt = (Number(allR.gfRatio)||1) + (Number(allR.bfRatio)||1);
  const allSharedTotal  = allGfDepBaseVal + allBfDepBaseVal;
  const allGfShouldPay  = allSharedTotal * (Number(allR.gfRatio)||1) / allRt;
  const allBfShouldPay  = allSharedTotal * (Number(allR.bfRatio)||1) / allRt;

  // 合計 = 支出 - 返金 - 本来負担 + 立替 - 個人支出
  const allGfDiff = allGfExpTotal - allJointToGf - allGfShouldPay + allNetGfAdv - allJointPersonalForGf;
  const allBfDiff = allBfExpTotal - allJointToBf - allBfShouldPay + allNetBfAdv - allJointPersonalForBf;

  const allGfEffDep = allGfDepBaseVal + allNetGfAdv;
  const allBfEffDep = allBfDepBaseVal + allNetBfAdv;

  // 詳細: 支出 / 返金 / 立替
  const fmtAdvA = v => v >= 0 ? fmt(v) : `-${fmt(-v)}`;
  const allGfDetailParts = [];
  if (allGfExpTotal > 0) allGfDetailParts.push(`支出 ${fmt(allGfExpTotal)}`);
  if (allJointToGf > 0)  allGfDetailParts.push(`返金 -${fmt(allJointToGf)}`);
  if (allNetGfAdv !== 0) allGfDetailParts.push(`立替 ${fmtAdvA(allNetGfAdv)}`);
  const allBfDetailParts = [];
  if (allBfExpTotal > 0) allBfDetailParts.push(`支出 ${fmt(allBfExpTotal)}`);
  if (allJointToBf > 0)  allBfDetailParts.push(`返金 -${fmt(allJointToBf)}`);
  if (allNetBfAdv !== 0) allBfDetailParts.push(`立替 ${fmtAdvA(allNetBfAdv)}`);

  // ── 全期間の入金額カード ──
  const allGfDepBase = Number(allR.gfRatio) || 0;
  const allBfDepBase = Number(allR.bfRatio) || 0;
  let allDepCard = '';
  if (allGfDepBase > 0 && allBfDepBase > 0) {
    let allDepMul = 1;
    while (allGfEffDep > allGfDepBase * allDepMul || allBfEffDep > allBfDepBase * allDepMul) { allDepMul++; }
    const allGfDepTarget = allGfDepBase * allDepMul;
    const allBfDepTarget = allBfDepBase * allDepMul;
    const allGfDepRemain = Math.max(0, allGfDepTarget - allGfEffDep);
    const allBfDepRemain = Math.max(0, allBfDepTarget - allBfEffDep);
    const fmtDepLineA = (base, adv, target, remain) => {
      const advStr = adv !== 0 ? ` + 立替 ${fmtAdvA(adv)}` : '';
      const remStr = remain > 0
        ? `→ <b>あと ${fmt(remain)}</b>`
        : `→ <b class="deposit-done">達成 ✓</b>`;
      return `入金済 ${fmt(base)}${advStr} ／ ${fmt(target)} ${remStr}`;
    };
    allDepCard = `
    <div class="breakdown-item deposit-target-item">
      <div class="bd-info">
        <div class="bd-name">💳 入金額</div>
        <div class="bd-detail" style="margin-top:4px">
          ${settings.gfName}：${fmtDepLineA(allGfDepBaseVal, allNetGfAdv, allGfDepTarget, allGfDepRemain)}
        </div>
        <div class="bd-detail" style="margin-top:4px">
          ${settings.bfName}：${fmtDepLineA(allBfDepBaseVal, allNetBfAdv, allBfDepTarget, allBfDepRemain)}
        </div>
      </div>
    </div>`;
  }

  const bdAllEl = document.getElementById('breakdown-list-all');
  bdAllEl.innerHTML = prevSettleHtml + allDepCard + `
    <div class="breakdown-item">
      <div class="bd-info">
        <div class="bd-name">${settings.gfName}</div>
        <div class="bd-detail">${allGfDetailParts.join(' / ') || '取引なし'}</div>
      </div>
      <div class="bd-amount ${allGfDiff>=0?'positive':'negative'}">
        ${allGfDiff>=0?'△':'▽'}${fmt(Math.round(Math.abs(allGfDiff)))}
        <div style="font-size:0.65rem;font-weight:400;color:var(--muted)">${allGfDiff>=0?'貰う':'払う'}</div>
      </div>
    </div>
    <div class="breakdown-item">
      <div class="bd-info">
        <div class="bd-name">${settings.bfName}</div>
        <div class="bd-detail">${allBfDetailParts.join(' / ') || '取引なし'}</div>
      </div>
      <div class="bd-amount ${allBfDiff>=0?'positive':'negative'}">
        ${allBfDiff>=0?'△':'▽'}${fmt(Math.round(Math.abs(allBfDiff)))}
        <div style="font-size:0.65rem;font-weight:400;color:var(--muted)">${allBfDiff>=0?'貰う':'払う'}</div>
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

// ── CSV ダウンロード ───────────────────────────────
function updateCsvYearSelect() {
  const sel = document.getElementById('csv-year-select');
  if (!sel) return;
  const years = new Set([...availableYears, ...Object.keys(transactionsByYear)]);
  const sorted = [...years].filter(Boolean).sort((a,b) => b.localeCompare(a));
  const curYear = localYearMonth().slice(0,4);
  if (!sorted.length) sorted.push(curYear);
  sel.innerHTML = sorted.map(y =>
    `<option value="${y}"${y===curYear?' selected':''}>${y}年</option>`
  ).join('');
}

document.getElementById('csv-dl-btn').addEventListener('click', async () => {
  const year = document.getElementById('csv-year-select').value;
  if (!year) return;
  await ensureYearLoaded(year);
  const yearTxs = transactionsByYear[year] || [];
  const csv  = '\uFEFF' + buildTransactionsCsv(yearTxs); // BOM付き（Excel対応）
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `kakeibo-history-${year}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// ── タブ切り替え ──────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'history') {
      if (historyShowAll) await ensureAllYearsLoaded();
      else await ensureYearLoaded(historyViewMonth.slice(0,4));
      updateCsvYearSelect();
      renderHistory();
    }
    if (btn.dataset.tab === 'settle') {
      await ensureAllYearsLoaded();
      renderSettle();
    }
  });
});

// ── 月ナビ（ホーム） ──────────────────────────────
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
document.getElementById('current-month-input').addEventListener('change', e => {
  if (!e.target.value) return;
  viewMonth = e.target.value;
  renderAll();
});

// ── 月ナビ（履歴） ────────────────────────────────
document.getElementById('history-all-btn').addEventListener('click', async () => {
  historyShowAll = true;
  await ensureAllYearsLoaded();
  renderHistory();
});
document.getElementById('history-prev-month').addEventListener('click', async () => {
  historyShowAll = false;
  const d = new Date(historyViewMonth + '-01');
  d.setMonth(d.getMonth() - 1);
  historyViewMonth = d.toISOString().slice(0,7);
  await ensureYearLoaded(historyViewMonth.slice(0,4));
  renderHistory();
});
document.getElementById('history-next-month').addEventListener('click', async () => {
  historyShowAll = false;
  const d = new Date(historyViewMonth + '-01');
  d.setMonth(d.getMonth() + 1);
  historyViewMonth = d.toISOString().slice(0,7);
  await ensureYearLoaded(historyViewMonth.slice(0,4));
  renderHistory();
});
document.getElementById('history-month-input').addEventListener('change', async e => {
  if (!e.target.value) return;
  historyShowAll   = false;
  historyViewMonth = e.target.value;
  await ensureYearLoaded(historyViewMonth.slice(0,4));
  renderHistory();
});

// ── 月ナビ（精算） ────────────────────────────────
document.getElementById('settle-prev-month').addEventListener('click', async () => {
  const d = new Date(settleViewMonth + '-01');
  d.setMonth(d.getMonth() - 1);
  settleViewMonth = d.toISOString().slice(0,7);
  await ensureYearLoaded(settleViewMonth.slice(0,4));
  renderSettle();
});
document.getElementById('settle-next-month').addEventListener('click', async () => {
  const d = new Date(settleViewMonth + '-01');
  d.setMonth(d.getMonth() + 1);
  settleViewMonth = d.toISOString().slice(0,7);
  await ensureYearLoaded(settleViewMonth.slice(0,4));
  renderSettle();
});
document.getElementById('settle-month-input').addEventListener('change', async e => {
  if (!e.target.value) return;
  settleViewMonth = e.target.value;
  await ensureYearLoaded(settleViewMonth.slice(0,4));
  renderSettle();
});

// ── モーダル ──────────────────────────────────────
const modalOverlay = document.getElementById('modal-overlay');

function openModal() {
  document.getElementById('input-amount').value = '';
  document.getElementById('input-note').value = '';
  // ローカル日付で今日をセット
  const _d = new Date();
  document.getElementById('input-date').value =
    `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')}`;
  setType('expense');
  setPayer('joint');       // 左端：共用財布
  setTransferTo('girlfriend'); // 左端：彼女
  setBeneficiary('none');
  setAdvanceTo('girlfriend');  // 左端：彼女
  modalOverlay.classList.add('active');
  setTimeout(() => document.getElementById('input-amount').focus(), 300);
}

function closeModal() {
  editingTxId = null;
  document.querySelector('#modal-overlay h2').textContent = '取引を追加';
  modalOverlay.classList.remove('active');
}

function setType(type) {
  currentType = type;
  document.querySelectorAll('.type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });

  const jointBtn      = document.getElementById('payer-joint-btn');
  const label         = document.getElementById('payer-group-label');
  const transferToGrp = document.getElementById('transfer-to-group');
  const advanceToGrp  = document.getElementById('advance-to-group');
  const categoryGrp   = document.getElementById('category-group');

  if (type === 'transfer') {
    label.textContent          = '振替元';
    jointBtn.style.display     = '';
    transferToGrp.style.display = 'block';
    advanceToGrp.style.display  = 'none';
    categoryGrp.style.display   = 'none';
  } else if (type === 'advance') {
    label.textContent          = '立替元';
    jointBtn.style.display     = '';
    transferToGrp.style.display = 'none';
    advanceToGrp.style.display  = 'block';
    categoryGrp.style.display   = 'block';
  } else {
    label.textContent          = '支出元';
    jointBtn.style.display     = '';
    transferToGrp.style.display = 'none';
    advanceToGrp.style.display  = 'none';
    categoryGrp.style.display   = 'block';
  }
}

function setPayer(payer) {
  currentPayer = payer;
  document.querySelectorAll('.payer-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.payer === payer);
  });
}

function setBeneficiary(ben) {
  currentBeneficiary = ben;
  document.querySelectorAll('.ben-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.ben === ben);
  });
}

function setAdvanceTo(to) {
  currentAdvanceTo = to;
  document.querySelectorAll('.advance-to-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.to === to);
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
document.querySelectorAll('.advance-to-btn').forEach(btn => {
  btn.addEventListener('click', () => setAdvanceTo(btn.dataset.to));
});

// ── 保存（新規追加 / 編集共通） ──────────────────────
document.getElementById('btn-save').addEventListener('click', () => {
  const amount = parseCalcAmount(document.getElementById('input-amount').value);
  const date   = document.getElementById('input-date').value;
  const note   = document.getElementById('input-note').value.trim();
  const cat    = document.getElementById('input-category').value;

  if (!amount || amount <= 0) { alert('金額を入力してください'); return; }
  if (!date) { alert('日付を入力してください'); return; }
  if (currentType === 'transfer' && currentPayer === currentTransferTo) {
    alert('振替元と振替先が同じです'); return;
  }
  if (currentType === 'advance' && currentPayer !== 'joint' && currentPayer === currentAdvanceTo) {
    alert('立替元と立替先が同じです'); return;
  }

  const txData = {
    type:     currentType,
    payer:    currentPayer,
    amount,
    category: currentType === 'transfer' ? '振替' : cat,
    note,
    date,
  };
  if (currentType === 'transfer') txData.transferTo  = currentTransferTo;
  if (currentType === 'advance')  txData.beneficiary = currentAdvanceTo;

  if (editingTxId !== null) {
    // ── 編集モード ──
    const oldTx   = transactions.find(t => t.id === editingTxId);
    const oldYear = oldTx?.date?.slice(0,4);
    const newYear = date.slice(0,4);
    const updTx   = { id: editingTxId, ...txData };

    // 古い年から除去
    if (oldYear && transactionsByYear[oldYear]) {
      transactionsByYear[oldYear] = transactionsByYear[oldYear].filter(t => t.id !== editingTxId);
    }
    transactions = transactions.filter(t => t.id !== editingTxId);

    // 新しい年に追加
    if (!transactionsByYear[newYear]) transactionsByYear[newYear] = [];
    transactionsByYear[newYear].unshift(updTx);
    transactions.unshift(updTx);

    save(newYear);
    if (oldYear && oldYear !== newYear) save(oldYear);
  } else {
    // ── 新規追加モード ──
    const tx     = { id: Date.now(), ...txData };
    const txYear = tx.date.slice(0,4);
    if (!transactionsByYear[txYear]) transactionsByYear[txYear] = [];
    transactionsByYear[txYear].unshift(tx);
    transactions.unshift(tx);
    save(txYear);
  }

  renderAll();
  closeModal();
});

// ── 編集モーダルを開く ────────────────────────────
function openEditModal(txId) {
  const tx = transactions.find(t => t.id === txId);
  if (!tx) return;
  editingTxId = txId;

  document.getElementById('input-amount').value = tx.amount;
  document.getElementById('input-note').value   = tx.note || '';
  document.getElementById('input-date').value   = tx.date;
  setType(tx.type);
  setPayer(tx.payer);
  if (tx.type === 'transfer') setTransferTo(tx.transferTo  || 'girlfriend');
  if (tx.type === 'advance')  setAdvanceTo(tx.beneficiary  || 'girlfriend');

  const catSel = document.getElementById('input-category');
  if (tx.category && [...catSel.options].some(o => o.value === tx.category)) {
    catSel.value = tx.category;
  }

  document.querySelector('#modal-overlay h2').textContent = '取引を編集';
  modalOverlay.classList.add('active');
  setTimeout(() => document.getElementById('input-amount').focus(), 300);
}

// ── 編集・削除（履歴） ────────────────────────────
document.getElementById('history-tx-list').addEventListener('click', e => {
  const editBtn = e.target.closest('.tx-edit');
  if (editBtn) {
    openEditModal(Number(editBtn.dataset.id));
    return;
  }
  const delBtn = e.target.closest('.tx-delete');
  if (delBtn && confirm('この取引を削除しますか？')) {
    const delId   = Number(delBtn.dataset.id);
    const delTx   = transactions.find(t => t.id === delId);
    const delYear = delTx?.date?.slice(0,4);
    if (delYear && transactionsByYear[delYear]) {
      transactionsByYear[delYear] = transactionsByYear[delYear].filter(t => t.id !== delId);
    }
    transactions = transactions.filter(t => t.id !== delId);
    // 削除IDを記録（同期時にリモートから復活しないようにする）
    deletedIds.add(String(delId));
    saveDeletedIds();
    save(delYear);
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
  // GitHub設定を表示（トークンはセキュリティのため非表示）
  document.getElementById('gh-token').value  = ghConfig.token  ? '（設定済み）' : '';
  document.getElementById('gh-repo').value   = ghConfig.repo   || '';
  document.getElementById('gh-branch').value = ghConfig.branch || '';
  renderRatioHistory();
  settingsOverlay.classList.add('active');
});

document.getElementById('gh-sync-now-btn').addEventListener('click', syncFromGitHub);
// トークン入力欄フォーカス時に「（設定済み）」をクリア
document.getElementById('gh-token').addEventListener('focus', function() {
  if (this.value === '（設定済み）') this.value = '';
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

  const gfR     = parseFloat(document.getElementById('setting-gf-ratio').value);
  const bfR     = parseFloat(document.getElementById('setting-bf-ratio').value);
  const rawDate = document.getElementById('setting-ratio-date').value; // "YYYY-MM"
  const date    = rawDate ? rawDate + '-01' : ''; // 月初(1日)に固定

  // 割合と日付が両方入力されている場合のみ追加
  if (gfR > 0 && bfR > 0 && date) {
    settings.ratioHistory = settings.ratioHistory.filter(r => r.from !== date);
    settings.ratioHistory.push({ from: date, gfRatio: gfR, bfRatio: bfR });
    document.getElementById('setting-gf-ratio').value = '';
    document.getElementById('setting-bf-ratio').value = '';
    document.getElementById('setting-ratio-date').value = '';
  }

  // GitHub 設定を保存（トークンは入力がある場合のみ更新。「設定済み」プレースホルダは除外）
  const token  = document.getElementById('gh-token').value.trim();
  const repo   = document.getElementById('gh-repo').value.trim();
  const branch = document.getElementById('gh-branch').value.trim();
  if (token && token !== '（設定済み）') ghConfig.token = token;
  if (repo)   ghConfig.repo   = repo;
  if (branch) ghConfig.branch = branch;
  saveGhConfig();

  save(null); // 設定のみ（取引ファイルは変更なし）
  applyNames();
  renderAll();
  settingsOverlay.classList.remove('active');

  // 設定保存後に自動で同期開始
  if (ghConfig.token && ghConfig.repo) syncFromGitHub();
});

// ── GitHub API 連動（年別ファイル・遅延読み込み） ──
let ghConfig = JSON.parse(localStorage.getItem('kakeibo_gh') || 'null') || {};
// 過去バグで「（設定済み）」が保存されていた場合はリセット
if (ghConfig.token === '（設定済み）') { ghConfig.token = ''; saveGhConfig(); }

const ghYearPath  = year => `kakeibo-history-${year}.csv`;
const GH_SET_PATH = 'kakeibo-settings.csv';

function saveGhConfig() {
  localStorage.setItem('kakeibo_gh', JSON.stringify(ghConfig));
}

// UTF-8 ⇔ Base64（日本語対応）
function toB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}
function fromB64(b64) {
  const bin   = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

// GitHub Contents API 共通処理
async function ghAPI(path, opts = {}) {
  const url = `https://api.github.com/repos/${ghConfig.repo}/contents/${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${ghConfig.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {})
    }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function ghRead(path) {
  const ref  = encodeURIComponent(ghConfig.branch || 'main');
  const data = await ghAPI(`${path}?ref=${ref}`);
  if (!data) return { content: null, sha: null };
  return { content: fromB64(data.content), sha: data.sha };
}

async function ghWrite(path, content, sha) {
  const body = {
    message: `update ${path}`,
    content: toB64(content),
    branch:  ghConfig.branch || 'main',
  };
  if (sha) body.sha = sha;
  const res = await ghAPI(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res?.content?.sha || sha;
}

// transactions を transactionsByYear から再構築
function rebuildTransactions() {
  transactions = Object.values(transactionsByYear).flat();
  transactions.sort((a,b) => b.date.localeCompare(a.date) || b.id - a.id);
  localStorage.setItem('couple_kakeibo', JSON.stringify(transactions));
}

// GitHub ルートディレクトリを一覧して年別ファイルを検出
async function listGhYearFiles() {
  const ref   = encodeURIComponent(ghConfig.branch || 'main');
  const files = await ghAPI(`?ref=${ref}`);
  if (!Array.isArray(files)) return;
  availableYears = [];
  files.forEach(f => {
    const m = f.name.match(/^kakeibo-history-(\d{4})\.csv$/);
    if (m) {
      availableYears.push(m[1]);
      ghYearShas[m[1]] = f.sha;
    }
  });
  availableYears.sort((a,b) => b.localeCompare(a)); // 新しい年が先
}

// 1年分のデータを GitHub から読み込む（force=true で強制再読み込み）
// 戻り値: ローカルにしかない取引があった場合は true（呼び出し元で書き戻しを行う）
async function loadYearFromGitHub(year, force = false) {
  if (!force && loadedYears.has(year)) return false;
  const { content, sha } = await ghRead(ghYearPath(year));
  ghYearShas[year] = sha || ghYearShas[year];

  const remoteTxs = content ? parseTransactionsCsv(content) : [];
  const localTxs  = transactionsByYear[year] || [];

  // 削除済みIDをリモートデータから除外（ローカルで削除したものを復活させない）
  const filteredRemoteTxs = remoteTxs.filter(t => !deletedIds.has(String(t.id)));

  let hasLocalOnly = false;
  if (localTxs.length > 0 && filteredRemoteTxs.length > 0) {
    // マージ：リモートを下敷きにしてローカルで上書き（ローカル優先）
    // → 編集がリモートの旧データで失われないようにするため
    const merged = {};
    filteredRemoteTxs.forEach(t => { merged[t.id] = t; }); // リモートを先に
    localTxs.forEach(t => { merged[t.id] = t; });           // ローカルで上書き
    transactionsByYear[year] = Object.values(merged);
    // ローカルにしかない取引があるか確認（書き戻しトリガー）
    const remoteIds = new Set(filteredRemoteTxs.map(t => String(t.id)));
    hasLocalOnly = localTxs.some(t => !remoteIds.has(String(t.id)));
  } else if (filteredRemoteTxs.length > 0) {
    transactionsByYear[year] = filteredRemoteTxs;
  } else {
    transactionsByYear[year] = localTxs;
  }

  loadedYears.add(year);
  rebuildTransactions();
  return hasLocalOnly;
}

// 指定年が未ロードなら読み込む
async function ensureYearLoaded(year) {
  if (!ghConfig.token || !ghConfig.repo) return;
  if (!loadedYears.has(year)) {
    updateGhStatus('syncing');
    try {
      await loadYearFromGitHub(year);
      updateGhStatus('ok');
    } catch(e) {
      console.error('GitHub load error:', e);
      updateGhStatus('error');
    }
  }
}

// 全年分をロード（精算タブ用）
async function ensureAllYearsLoaded() {
  if (!ghConfig.token || !ghConfig.repo) return;
  const unloaded = availableYears.filter(y => !loadedYears.has(y));
  if (!unloaded.length) return;
  updateGhStatus('syncing');
  try {
    await Promise.all(unloaded.map(y => loadYearFromGitHub(y)));
    updateGhStatus('ok');
  } catch(e) {
    console.error('GitHub load error:', e);
    updateGhStatus('error');
  }
}

// 設定CSVビルド・パース
function buildSettingsCsv() {
  const lines = [
    'gfName,' + settings.gfName,
    'bfName,' + settings.bfName,
    'ratioFrom,gfRatio,bfRatio',
  ];
  [...settings.ratioHistory]
    .sort((a,b) => a.from.localeCompare(b.from))
    .forEach(r => lines.push(`${r.from},${r.gfRatio},${r.bfRatio}`));
  return lines.join('\n');
}

function applySettingsFromCsv(text) {
  text = text.replace(/^\ufeff/, '');
  const lines = text.trim().split(/\r?\n/);
  let ratioHeader = false;
  const ratios = [];
  lines.forEach(line => {
    const parts = line.split(',');
    if      (parts[0] === 'gfName')    settings.gfName = parts[1] || settings.gfName;
    else if (parts[0] === 'bfName')    settings.bfName = parts[1] || settings.bfName;
    else if (parts[0] === 'ratioFrom') ratioHeader = true;
    else if (ratioHeader && parts.length >= 3) {
      const gfR = parseFloat(parts[1]), bfR = parseFloat(parts[2]);
      if (parts[0] && !isNaN(gfR) && !isNaN(bfR))
        ratios.push({ from: parts[0], gfRatio: gfR, bfRatio: bfR });
    }
  });
  if (ratios.length) settings.ratioHistory = ratios;
  localStorage.setItem('couple_settings', JSON.stringify(settings));
  applyNames();
}

// 同期ステータス表示（detail: HTTPステータスコードなど任意の補足）
function updateGhStatus(state, detail) {
  const map = {
    none:    { text: '未設定',      cls: 'gh-none'    },
    syncing: { text: '⟳ 同期中…',  cls: 'gh-syncing' },
    ok:      { text: '✓ 同期済み', cls: 'gh-ok'      },
    error:   { text: '✕ エラー',   cls: 'gh-error'   },
  };
  const s    = map[state] || map.none;
  const text = detail ? `${s.text} ${detail}` : s.text;

  // 設定モーダル内のステータス
  const el = document.getElementById('gh-sync-status');
  if (el) { el.textContent = text; el.className = `gh-sync-status ${s.cls}`; }

  // ヘッダー常時表示ステータス（未設定時は非表示）
  const hdr = document.getElementById('gh-sync-status-header');
  if (hdr) {
    if (state === 'none') {
      hdr.textContent = '';
      hdr.className   = 'gh-sync-status-header';
    } else {
      hdr.textContent = text;
      hdr.className   = `gh-sync-status-header ${s.cls}`;
    }
  }

  // トークン失効（401）の検出・解除
  if (state === 'error' && detail === '401') {
    localStorage.setItem('kakeibo_token_expired', '1');
    showTokenExpiredAlert();
  } else if (state === 'ok') {
    localStorage.removeItem('kakeibo_token_expired');
  }
}

// ── トークン失効アラート ────────────────────────────
function showTokenExpiredAlert() {
  // すでにこのセッションで表示済みなら何もしない
  if (sessionStorage.getItem('token_alert_shown')) return;
  const overlay = document.getElementById('token-expired-overlay');
  if (overlay) overlay.classList.add('active');
}

function initTokenExpiredAlert() {
  // ページ読み込み時：localStorage フラグが立っていたら表示
  if (localStorage.getItem('kakeibo_token_expired') !== '1') return;
  showTokenExpiredAlert();
  const btn = document.getElementById('token-expired-ok');
  if (btn) {
    btn.addEventListener('click', () => {
      sessionStorage.setItem('token_alert_shown', '1');
      const overlay = document.getElementById('token-expired-overlay');
      if (overlay) overlay.classList.remove('active');
    });
  }
}

// GitHub から読み込み（起動時：当年のみ、他は遅延）
async function syncFromGitHub() {
  // トークン・リポジトリが未設定または不正な場合はスキップ
  const hasValidToken = ghConfig.token && ghConfig.token !== '（設定済み）';
  if (!hasValidToken || !ghConfig.repo) { updateGhStatus('none'); return; }
  // 多重実行防止
  if (ghSyncing) return;
  ghSyncing = true;
  updateGhStatus('syncing');
  try {
    // 年別ファイル一覧を取得
    await listGhYearFiles();

    // 当年データを強制再読み込み（キャッシュ無効）
    // ローカルにしかない取引があれば、ここで書き戻す（同期完了前に直列処理）
    const currentYear = new Date().getFullYear().toString();
    const needsWriteBack = await loadYearFromGitHub(currentYear, true);
    if (needsWriteBack) {
      await writeYearToGitHub(currentYear);
    }

    // 設定データを読み込み
    // ローカルに未送信の設定変更がある場合（タイマー発火待ち）はGitHub値で上書きしない
    const { content: setContent, sha: setSha } = await ghRead(GH_SET_PATH);
    if (setContent) {
      ghSetSha = setSha;
      if (ghSetSyncTimer === null) {
        // ペンディング中の書き込みがない場合のみ適用（ローカル優先）
        applySettingsFromCsv(setContent);
      }
    }

    updateGhStatus('ok');
    updateCsvYearSelect();
  } catch(e) {
    // HTTPステータスを抽出して表示
    const status = e.message?.match(/GitHub API (\d+)/)?.[1];
    console.error('GitHub sync error:', e.message || e);
    updateGhStatus('error', status);
  } finally {
    ghSyncing = false;
  }
  // 描画は同期の成否に関わらず実行（描画エラーを同期エラーと混同しない）
  renderAll();
}

// 指定年のファイルを GitHub へ書き込む（デバウンス付き・2秒後）
// 409/422（SHA競合）の場合は最新データをマージしてリトライする
function scheduleSyncYearToGitHub(year) {
  if (!ghConfig.token || !ghConfig.repo || !year) return;
  clearTimeout(ghSyncTimers[year]);
  ghSyncTimers[year] = setTimeout(async () => {
    // メインの同期中は少し待ってリトライ
    if (ghSyncing) { scheduleSyncYearToGitHub(year); return; }
    updateGhStatus('syncing');
    try {
      await writeYearToGitHub(year);
      updateGhStatus('ok');
    } catch(e) {
      const status = e.message?.match(/GitHub API (\d+)/)?.[1];
      console.error('GitHub write error:', e);
      updateGhStatus('error', status);
    }
  }, 2000);
}

// 年データを GitHub へ書き込む
// ・書き込み前に最新 SHA を取得（422回避）
// ・マージはしない（削除・編集がリモートデータで上書きされるのを防ぐ）
// ・409/422（SHA競合）時は SHA 再取得して1回リトライ
async function writeYearToGitHub(year) {
  const yearTxs = transactionsByYear[year] || [];

  // 409/422（SHA競合）が出ても最大3回リトライ（待ち時間を増やしながら）
  const MAX_RETRY = 3;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    // 毎回最新 SHA を取得
    const { sha } = await ghRead(ghYearPath(year));
    if (sha) ghYearShas[year] = sha;

    try {
      ghYearShas[year] = await ghWrite(ghYearPath(year), buildTransactionsCsv(yearTxs), ghYearShas[year]);
      return; // 成功
    } catch(e) {
      const is409 = /GitHub API (409|422)/.test(e.message);
      if (is409 && attempt < MAX_RETRY - 1) {
        // 少し待ってリトライ（500ms → 1000ms → 1500ms）
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw e; // 最終リトライも失敗、または別エラー
    }
  }
}

// 設定のみ GitHub へ書き込む（デバウンス付き）
let ghSetSyncTimer = null;
function scheduleSyncSettingsToGitHub() {
  if (!ghConfig.token || !ghConfig.repo) return;
  clearTimeout(ghSetSyncTimer);
  ghSetSyncTimer = setTimeout(async () => {
    try {
      // sha が未取得の場合は先に読んで取得（既存ファイルへの上書きに必要）
      if (!ghSetSha) {
        const { sha } = await ghRead(GH_SET_PATH);
        if (sha) ghSetSha = sha;
      }
      ghSetSha = await ghWrite(GH_SET_PATH, buildSettingsCsv(), ghSetSha);
    } catch(e) {
      console.error('GitHub settings write error:', e);
    }
  }, 2000);
}

// ── 取引CSV ビルド・パース ─────────────────────────
function buildTransactionsCsv(txs) {
  const header = 'id,type,payer,amount,category,note,date,transferTo,beneficiary';
  const rows = txs
    .slice()
    .sort((a,b) => a.date.localeCompare(b.date) || a.id - b.id)
    .map(t => [
      t.id, t.type, t.payer, t.amount,
      t.category    || '',
      '"' + (t.note || '').replace(/"/g, '""') + '"',
      t.date,
      t.transferTo  || '',
      t.beneficiary || ''
    ].join(','));
  return [header, ...rows].join('\n');
}

// CSV パース
function parseCsvLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      result.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}
function parseTransactionsCsv(text) {
  text = text.replace(/^\ufeff/, '');
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  const idx = h => headers.indexOf(h);
  const result = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols  = parseCsvLine(lines[i]);
    const amount = parseInt(cols[idx('amount')]);
    if (!amount || amount <= 0) continue;
    const tx = {
      id:       parseInt(cols[idx('id')]) || Date.now() + i,
      type:     cols[idx('type')]     || 'expense',
      payer:    cols[idx('payer')]    || 'girlfriend',
      amount,
      category: cols[idx('category')] || 'その他',
      note:     cols[idx('note')]     || '',
      date:     cols[idx('date')]     || '',
    };
    const transferTo  = cols[idx('transferTo')];
    const beneficiary = cols[idx('beneficiary')];
    if (transferTo)  tx.transferTo  = transferTo;
    if (beneficiary) tx.beneficiary = beneficiary;
    if (tx.date) result.push(tx);
  }
  return result;
}


// ── 設定モーダル アコーディオン ──────────────────────
[
  { toggleId: 'ratio-add-toggle', bodyId: 'ratio-add-body' },
  { toggleId: 'github-toggle',    bodyId: 'github-body'    },
].forEach(({ toggleId, bodyId }) => {
  const toggle = document.getElementById(toggleId);
  const body   = document.getElementById(bodyId);
  if (!toggle || !body) return;
  toggle.addEventListener('click', () => {
    const isOpen = toggle.classList.contains('open');
    toggle.classList.toggle('open', !isOpen);
    body.style.display = isOpen ? 'none' : 'block';
  });
});

// ── リロード ──────────────────────────────────────
document.getElementById('reload-btn').addEventListener('click', () => {
  location.reload();
});

// ── ログアウト ────────────────────────────────────
document.getElementById('logout-btn').addEventListener('click', () => {
  if (confirm('ログアウトしますか？')) {
    sessionStorage.removeItem('kakeibo_auth');
    location.replace('login.html');
  }
});

// ── バックグラウンド移行時に pending な書き込みを即時実行 ──────────
// タブ消去・スリープ・ログアウト前に2秒タイマーを待たず即座に同期する
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  if (!ghConfig.token || !ghConfig.repo) return;
  // メイン同期中は競合するので何もしない（syncFromGitHub 内で書き戻し済み）
  if (ghSyncing) return;

  // pending な年ファイル書き込みを即時実行（タイマーをキャンセルして即時起動）
  const pendingYears = Object.keys(ghSyncTimers).filter(y => ghSyncTimers[y] != null);
  pendingYears.forEach(year => {
    clearTimeout(ghSyncTimers[year]);
    ghSyncTimers[year] = null;
  });
  if (pendingYears.length > 0) {
    // 直列に実行して競合を防ぐ
    pendingYears.reduce((p, year) =>
      p.then(() => writeYearToGitHub(year)).catch(e => console.error('visibility write error:', e)),
      Promise.resolve()
    );
  }

  // pending な設定ファイル書き込みを即時実行
  if (ghSetSyncTimer != null) {
    clearTimeout(ghSetSyncTimer);
    ghSetSyncTimer = null;
    scheduleSyncSettingsToGitHub._flush?.();
    ghRead(GH_SET_PATH).then(({ sha }) => {
      if (sha) ghSetSha = sha;
      return ghAPI(GH_SET_PATH, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `update ${GH_SET_PATH}`,
          content: toB64(buildSettingsCsv()),
          branch:  ghConfig.branch || 'main',
          ...(ghSetSha ? { sha: ghSetSha } : {})
        })
      });
    }).then(r => { if (r?.content?.sha) ghSetSha = r.content.sha; })
      .catch(e => console.error('visibility settings write error:', e));
  }
});

// ── 電卓式パース ──────────────────────────────────
function parseCalcAmount(str) {
  if (!str) return NaN;
  const cleaned = String(str)
    .replace(/[,，\s]/g, '')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/−/g, '-');
  if (!/^[\d+\-*/.()]+$/.test(cleaned)) return NaN;
  try {
    // eslint-disable-next-line no-new-func
    const result = Function('"use strict"; return (' + cleaned + ')')();
    if (!isFinite(result) || result <= 0) return NaN;
    return Math.floor(result);
  } catch(e) { return NaN; }
}

// ── 電卓キーボード ──────────────────────────────────
(function() {
  const calcKb  = document.getElementById('calc-kb');
  const amtInput = document.getElementById('input-amount');
  if (!calcKb || !amtInput) return;

  function showCalc() {
    calcKb.classList.add('active');
    // 電卓が入力欄を隠さないよう、モーダルにpaddingBottomを設定してスクロール
    requestAnimationFrame(() => {
      const modal = document.querySelector('.modal-overlay.active .modal');
      if (!modal) return;
      const calcH = calcKb.offsetHeight;
      modal.style.paddingBottom = (calcH + 20) + 'px';
      const inputRect = amtInput.getBoundingClientRect();
      const visibleBottom = window.innerHeight - calcH - 12; // 12px の余裕
      if (inputRect.bottom > visibleBottom) {
        modal.scrollTop += inputRect.bottom - visibleBottom;
      }
    });
  }
  function hideCalc() {
    calcKb.classList.remove('active');
    const modal = document.querySelector('.modal-overlay.active .modal');
    if (modal) modal.style.paddingBottom = '';
  }

  // フォーカス時に電卓表示
  amtInput.addEventListener('focus', showCalc);
  // フォーカス外れたら電卓を閉じる（calc ボタンは mousedown.preventDefault で blur させない）
  amtInput.addEventListener('blur', () => {
    // 少し遅延：calc ボタン click が先に発火してから閉じる
    setTimeout(hideCalc, 200);
  });

  // ── ボタン処理 ──
  function handleCalcBtn(btn) {
    const action = btn.dataset.action;
    const val    = btn.dataset.val;
    let cur = amtInput.value;

    if (action === 'clear') {
      amtInput.value = '';
    } else if (action === 'back') {
      amtInput.value = cur.slice(0, -1);
    } else if (action === 'eq' || action === 'done') {
      const r = parseCalcAmount(cur);
      if (r !== null && !isNaN(r)) amtInput.value = String(r);
      if (action === 'done') { amtInput.blur(); }
    } else if (val) {
      const isOp = (c) => '+-×÷−*/'.includes(c);
      if (isOp(val) && isOp(cur.slice(-1))) {
        amtInput.value = cur.slice(0, -1) + val; // 演算子を置換
      } else {
        amtInput.value = cur + val;
      }
    }
  }

  calcKb.querySelectorAll('.calc-btn').forEach(btn => {
    // mousedown で preventDefault → input のフォーカスを維持（OS キーボードを出さない）
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
    btn.addEventListener('touchend', e => { e.preventDefault(); handleCalcBtn(btn); });
    btn.addEventListener('click', () => handleCalcBtn(btn));
  });

  // キャンセル・保存ボタンで電卓を閉じる
  document.getElementById('btn-cancel')?.addEventListener('click', hideCalc);
  document.getElementById('modal-overlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) hideCalc();
  });
})();

// ── スワイプでタブ切り替え ────────────────────────────
(function() {
  const TABS = ['home', 'history', 'settle'];
  let tx0 = 0, ty0 = 0;

  function currentTabIdx() {
    const active = document.querySelector('.tab-btn.active');
    return TABS.indexOf(active?.dataset.tab ?? 'home');
  }

  async function goToTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const btn = document.querySelector(`.tab-btn[data-tab="${name}"]`);
    btn?.classList.add('active');
    document.getElementById('tab-' + name)?.classList.add('active');
    if (name === 'history') {
      if (historyShowAll) await ensureAllYearsLoaded();
      else await ensureYearLoaded(historyViewMonth.slice(0,4));
      updateCsvYearSelect();
      renderHistory();
    }
    if (name === 'settle') {
      await ensureAllYearsLoaded();
      renderSettle();
    }
  }

  document.addEventListener('touchstart', e => {
    // モーダル・電卓が開いていたら無視
    if (document.querySelector('.modal-overlay.active')) return;
    if (document.getElementById('calc-kb')?.classList.contains('active')) return;
    tx0 = e.touches[0].clientX;
    ty0 = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (document.querySelector('.modal-overlay.active')) return;
    if (document.getElementById('calc-kb')?.classList.contains('active')) return;
    const dx = e.changedTouches[0].clientX - tx0;
    const dy = e.changedTouches[0].clientY - ty0;
    // 横スワイプのみ判定（縦成分が横成分より大きい場合はスクロールとみなす）
    if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx) * 0.7) return;
    const idx = currentTabIdx();
    if (dx < 0 && idx < TABS.length - 1) goToTab(TABS[idx + 1]); // 左スワイプ→次のタブ
    if (dx > 0 && idx > 0)              goToTab(TABS[idx - 1]); // 右スワイプ→前のタブ
  }, { passive: true });
})();

// ── 初期化 ────────────────────────────────────────
applyNames();
renderAll();
initTokenExpiredAlert(); // トークン失効アラートの初期化
syncFromGitHub();        // GitHub API で自動同期
