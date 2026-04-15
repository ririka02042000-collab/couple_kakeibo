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
  expense: '支出', income: '収入', deposit: '貯金入金', withdraw: '貯金出金'
};

// ── 状態 ──────────────────────────────────────────
let transactions = JSON.parse(localStorage.getItem('couple_kakeibo') || '[]');
let settings     = JSON.parse(localStorage.getItem('couple_settings') || '{"gfName":"彼女","bfName":"彼氏","gfRatio":1,"bfRatio":1}');
let currentType  = 'expense';
let currentPayer = 'girlfriend';
let viewMonth    = new Date().toISOString().slice(0, 7); // "YYYY-MM"

// ── ユーティリティ ─────────────────────────────────
const fmt  = n  => '¥' + Math.abs(n).toLocaleString('ja-JP');
const sign = (type, n) => {
  if (type === 'income') return '+' + fmt(n);
  if (type === 'deposit') return '+' + fmt(n);
  if (type === 'withdraw') return '-' + fmt(n);
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

// ── 名前適用 ──────────────────────────────────────
function applyNames() {
  document.getElementById('name-girlfriend-display').textContent = settings.gfName;
  document.getElementById('name-boyfriend-display').textContent  = settings.bfName;
  document.getElementById('payer-gf-label').textContent = settings.gfName;
  document.getElementById('payer-bf-label').textContent = settings.bfName;
  document.getElementById('setting-gf-name').value = settings.gfName;
  document.getElementById('setting-bf-name').value = settings.bfName;
  document.getElementById('setting-gf-ratio').value = settings.gfRatio || '';
  document.getElementById('setting-bf-ratio').value = settings.bfRatio || '';
  document.getElementById('ratio-gf-label').textContent = settings.gfName;
  document.getElementById('ratio-bf-label').textContent = settings.bfName;

  // フィルターの選択肢も更新
  const opts = document.querySelectorAll('#filter-payer option');
  opts[1].textContent = settings.gfName;
  opts[2].textContent = settings.bfName;
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

  // 彼女支出
  const gfExp = txs.filter(t => t.payer === 'girlfriend' && t.type === 'expense')
                    .reduce((s,t) => s+t.amount, 0);
  // 彼氏支出
  const bfExp = txs.filter(t => t.payer === 'boyfriend'  && t.type === 'expense')
                    .reduce((s,t) => s+t.amount, 0);
  // 共同貯金残高（全期間）
  const jointIn  = transactions.filter(t => t.type === 'deposit').reduce((s,t)=>s+t.amount,0);
  const jointOut = transactions.filter(t => t.type === 'withdraw').reduce((s,t)=>s+t.amount,0);

  document.getElementById('gf-amount').textContent = fmt(gfExp);
  document.getElementById('bf-amount').textContent = fmt(bfExp);
  document.getElementById('joint-balance').textContent = fmt(jointIn - jointOut);
  document.getElementById('joint-in').textContent  = fmt(jointIn);
  document.getElementById('joint-out').textContent = fmt(jointOut);

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
                    : t.payer === 'boyfriend'  ? settings.bfName : '共同貯金';
    const metaParts = [payerName, fmtDate(t.date)];
    if (t.note) metaParts.push(escHtml(t.note));

    const item = document.createElement('div');
    item.className = 'tx-item';
    item.innerHTML = `
      <div class="tx-payer-badge ${pi.class}">${pi.emoji}</div>
      <div class="tx-info">
        <div class="tx-category">${t.category || TYPE_LABELS[t.type]}</div>
        <div class="tx-meta">${metaParts.join(' · ')}</div>
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

  // 個人支出（精算対象：共同貯金払いは除外）
  const gfExp  = txs.filter(t=>t.payer==='girlfriend'&&t.type==='expense').reduce((s,t)=>s+t.amount,0);
  const bfExp  = txs.filter(t=>t.payer==='boyfriend' &&t.type==='expense').reduce((s,t)=>s+t.amount,0);
  const jExp   = txs.filter(t=>t.payer==='joint'     &&t.type==='expense').reduce((s,t)=>s+t.amount,0);
  const gfInc  = txs.filter(t=>t.payer==='girlfriend'&&t.type==='income').reduce((s,t)=>s+t.amount,0);
  const bfInc  = txs.filter(t=>t.payer==='boyfriend' &&t.type==='income').reduce((s,t)=>s+t.amount,0);
  // 貯金入金（入金者別）
  const gfDep  = txs.filter(t=>t.payer==='girlfriend'&&t.type==='deposit').reduce((s,t)=>s+t.amount,0);
  const bfDep  = txs.filter(t=>t.payer==='boyfriend' &&t.type==='deposit').reduce((s,t)=>s+t.amount,0);
  const jDep   = gfDep + bfDep;
  const jWit   = txs.filter(t=>t.type==='withdraw').reduce((s,t)=>s+t.amount,0);

  // 精算は個人支出のみ対象（共同貯金払い jExp は除外）
  const total = gfExp + bfExp;

  // 負担割合を計算（設定値をそのまま比率として使用）
  const gfR = Number(settings.gfRatio) || 1;
  const bfR = Number(settings.bfRatio) || 1;
  const ratioTotal = gfR + bfR;

  // 各自の「本来負担すべき金額」
  const gfShouldPay = total * (gfR / ratioTotal);
  const bfShouldPay = total * (bfR / ratioTotal);

  // 実際に払った額との差 (正 = 払いすぎ、負 = 払い足りない)
  const gfDiff = gfExp - gfShouldPay;
  const bfDiff = bfExp - bfShouldPay;

  const iconEl   = document.getElementById('settle-icon');
  const descEl   = document.getElementById('settle-desc');
  const amountEl = document.getElementById('settle-amount');

  if (total === 0) {
    iconEl.textContent   = '⚖️';
    descEl.textContent   = '今月の支出はありません';
    amountEl.textContent = '';
  } else if (Math.abs(gfDiff) < 10) {
    iconEl.textContent   = '✅';
    descEl.textContent   = '精算の必要はありません！';
    amountEl.textContent = '';
  } else if (gfDiff > 0) {
    // 彼女が払いすぎ → 彼氏が彼女に払う
    iconEl.textContent   = '💸';
    descEl.textContent   = `${settings.bfName} → ${settings.gfName}`;
    amountEl.textContent = fmt(Math.round(gfDiff)) + ' お支払い';
  } else {
    // 彼氏が払いすぎ → 彼女が彼氏に払う
    iconEl.textContent   = '💸';
    descEl.textContent   = `${settings.gfName} → ${settings.bfName}`;
    amountEl.textContent = fmt(Math.round(bfDiff)) + ' お支払い';
  }

  // 割合表示テキスト
  const ratioLabel = (gfR === bfR)
    ? '（折半）'
    : `（${settings.gfName} ${gfR} : ${settings.bfName} ${bfR}）`;

  // 内訳
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
      <div class="bd-avatar">👩</div>
      <div class="bd-info">
        <div class="bd-name">${settings.gfName}</div>
        <div class="bd-detail">実際の支出 ${fmt(gfExp)} / 収入 ${fmt(gfInc)}</div>
      </div>
      <div class="bd-amount ${gfDiff>=0?'positive':'negative'}">
        ${gfDiff>=0?'△':'▲'}${fmt(Math.round(Math.abs(gfDiff)))}
        <div style="font-size:0.65rem;font-weight:400;color:var(--muted)">${gfDiff>=0?'払いすぎ':'不足'}</div>
      </div>
    </div>
    <div class="breakdown-item">
      <div class="bd-avatar">👨</div>
      <div class="bd-info">
        <div class="bd-name">${settings.bfName}</div>
        <div class="bd-detail">実際の支出 ${fmt(bfExp)} / 収入 ${fmt(bfInc)}</div>
      </div>
      <div class="bd-amount ${bfDiff>=0?'positive':'negative'}">
        ${bfDiff>=0?'△':'▲'}${fmt(Math.round(Math.abs(bfDiff)))}
        <div style="font-size:0.65rem;font-weight:400;color:var(--muted)">${bfDiff>=0?'払いすぎ':'不足'}</div>
      </div>
    </div>
    <div class="breakdown-item">
      <div class="bd-avatar">🏦</div>
      <div class="bd-info">
        <div class="bd-name">共同貯金</div>
        <div class="bd-detail">
          入金 ${fmt(jDep)}（${settings.gfName} ${fmt(gfDep)} / ${settings.bfName} ${fmt(bfDep)}）<br>
          出金 ${fmt(jWit)} / 共同払い ${fmt(jExp)}
        </div>
      </div>
      <div class="bd-amount ${jDep-jWit>=0?'positive':'negative'}">${jDep-jWit>=0?'+':''}${fmt(jDep-jWit)}</div>
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
  modalOverlay.classList.add('active');
  setTimeout(() => document.getElementById('input-amount').focus(), 300);
}

function closeModal() { modalOverlay.classList.remove('active'); }

function setType(type) {
  currentType = type;
  document.querySelectorAll('.type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });

  const jointBtn = document.getElementById('payer-joint-btn');
  const label    = document.getElementById('payer-group-label');

  if (type === 'withdraw') {
    // 出金は個人特定不要 — 支出元ごと非表示
    document.getElementById('payer-group').style.display    = 'none';
    document.getElementById('category-group').style.display = 'none';
  } else if (type === 'deposit') {
    // 入金者は彼女/彼氏のみ（共同貯金ボタンを隠す）
    document.getElementById('payer-group').style.display    = 'block';
    document.getElementById('category-group').style.display = 'none';
    label.textContent     = '入金者';
    jointBtn.style.display = 'none';
    if (currentPayer === 'joint') setPayer('girlfriend');
  } else {
    // expense / income — 全3択（共同貯金含む）
    document.getElementById('payer-group').style.display    = 'block';
    document.getElementById('category-group').style.display = 'block';
    label.textContent      = type === 'expense' ? '支出元' : '収入先';
    jointBtn.style.display = '';
  }
}

function setPayer(payer) {
  currentPayer = payer;
  document.querySelectorAll('.payer-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.payer === payer);
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

// ── 保存 ──────────────────────────────────────────
document.getElementById('btn-save').addEventListener('click', () => {
  const amount = parseInt(document.getElementById('input-amount').value);
  const date   = document.getElementById('input-date').value;
  const note   = document.getElementById('input-note').value.trim();
  const cat    = document.getElementById('input-category').value;

  if (!amount || amount <= 0) { alert('金額を入力してください'); return; }
  if (!date) { alert('日付を入力してください'); return; }

  // payer の決定
  // - withdraw は常に joint
  // - deposit は currentPayer (gf/bf) — 誰が入金したか記録
  // - expense/income は currentPayer (gf/bf/joint)
  const payer = currentType === 'withdraw' ? 'joint' : currentPayer;

  transactions.unshift({
    id: Date.now(),
    type: currentType,
    payer,
    amount,
    category: (currentType === 'deposit' || currentType === 'withdraw') ? '共同貯金' : cat,
    note,
    date
  });

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
  settingsOverlay.classList.add('active');
});

document.getElementById('settings-cancel').addEventListener('click', () => {
  settingsOverlay.classList.remove('active');
});

settingsOverlay.addEventListener('click', e => {
  if (e.target === settingsOverlay) settingsOverlay.classList.remove('active');
});

document.getElementById('settings-save').addEventListener('click', () => {
  settings.gfName  = document.getElementById('setting-gf-name').value.trim() || '彼女';
  settings.bfName  = document.getElementById('setting-bf-name').value.trim() || '彼氏';
  const gfR = parseFloat(document.getElementById('setting-gf-ratio').value);
  const bfR = parseFloat(document.getElementById('setting-bf-ratio').value);
  settings.gfRatio = (gfR > 0) ? gfR : 1;
  settings.bfRatio = (bfR > 0) ? bfR : 1;
  save();
  applyNames();
  renderAll();
  settingsOverlay.classList.remove('active');
});

// ── 初期化 ────────────────────────────────────────
applyNames();
renderAll();
