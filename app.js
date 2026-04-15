// カテゴリアイコンマップ
const CATEGORY_ICONS = {
  '給与': '💰', '副収入': '💵', '食費': '🍽️', '住居費': '🏠',
  '交通費': '🚃', '光熱費': '💡', '通信費': '📱', '医療費': '🏥',
  '娯楽費': '🎮', '衣類': '👗', 'その他': '📦'
};

let transactions = JSON.parse(localStorage.getItem('kakeibo_transactions') || '[]');
let editingId = null;
let currentType = 'expense';

// 要素取得
const balanceEl = document.getElementById('balance');
const totalIncomeEl = document.getElementById('total-income');
const totalExpenseEl = document.getElementById('total-expense');
const listEl = document.getElementById('transaction-list');
const emptyMsg = document.getElementById('empty-msg');
const modalOverlay = document.getElementById('modal-overlay');
const filterMonth = document.getElementById('filter-month');
const filterCategory = document.getElementById('filter-category');
const filterType = document.getElementById('filter-type');

// 今日の日付をデフォルトにセット
document.getElementById('input-date').valueAsDate = new Date();

// 月フィルター選択肢を生成
function updateMonthOptions() {
  const months = [...new Set(transactions.map(t => t.date.slice(0, 7)))].sort().reverse();
  const current = filterMonth.value;
  filterMonth.innerHTML = '<option value="">すべての月</option>';
  months.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m.replace('-', '年') + '月';
    if (m === current) opt.selected = true;
    filterMonth.appendChild(opt);
  });
}

// 保存
function save() {
  localStorage.setItem('kakeibo_transactions', JSON.stringify(transactions));
}

// フィルタリング済みトランザクション取得
function getFiltered() {
  return transactions.filter(t => {
    if (filterMonth.value && !t.date.startsWith(filterMonth.value)) return false;
    if (filterCategory.value && t.category !== filterCategory.value) return false;
    if (filterType.value && t.type !== filterType.value) return false;
    return true;
  });
}

// 残高・集計更新
function updateSummary() {
  const filtered = getFiltered();
  const income = filtered.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expense = filtered.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const balance = income - expense;

  balanceEl.textContent = formatCurrency(balance);
  balanceEl.style.color = balance < 0 ? '#fca5a5' : 'white';
  totalIncomeEl.textContent = formatCurrency(income);
  totalExpenseEl.textContent = formatCurrency(expense);
}

function formatCurrency(n) {
  return '¥' + Math.abs(n).toLocaleString('ja-JP');
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

// リスト描画
function render() {
  updateMonthOptions();
  updateSummary();

  const filtered = getFiltered().slice().sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

  // 既存アイテムを削除（emptyMsg は残す）
  [...listEl.querySelectorAll('.transaction-item')].forEach(el => el.remove());

  if (filtered.length === 0) {
    emptyMsg.style.display = 'block';
    return;
  }
  emptyMsg.style.display = 'none';

  filtered.forEach(t => {
    const item = document.createElement('div');
    item.className = 'transaction-item';
    item.innerHTML = `
      <div class="tx-icon ${t.type}">${CATEGORY_ICONS[t.category] || '📦'}</div>
      <div class="tx-info">
        <div class="tx-category">${t.category}</div>
        ${t.note ? `<div class="tx-note">${escapeHtml(t.note)}</div>` : ''}
        <div class="tx-date">${formatDate(t.date)}</div>
      </div>
      <div class="tx-amount ${t.type}">${t.type === 'income' ? '+' : '-'}${formatCurrency(t.amount)}</div>
      <button class="tx-delete" data-id="${t.id}" title="削除">✕</button>
    `;
    listEl.appendChild(item);
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// モーダル開閉
function openModal() {
  editingId = null;
  document.getElementById('modal-title').textContent = '取引を追加';
  document.getElementById('input-amount').value = '';
  document.getElementById('input-note').value = '';
  document.getElementById('input-date').valueAsDate = new Date();
  setType('expense');
  modalOverlay.classList.add('active');
  setTimeout(() => document.getElementById('input-amount').focus(), 300);
}

function closeModal() {
  modalOverlay.classList.remove('active');
}

function setType(type) {
  currentType = type;
  document.getElementById('btn-expense').classList.toggle('active', type === 'expense');
  document.getElementById('btn-income').classList.toggle('active', type === 'income');

  // 収入時はカテゴリを給与に
  const catSelect = document.getElementById('input-category');
  if (type === 'income') {
    catSelect.value = '給与';
  } else {
    catSelect.value = '食費';
  }
}

// 保存処理
function saveTransaction() {
  const amount = parseInt(document.getElementById('input-amount').value);
  const category = document.getElementById('input-category').value;
  const note = document.getElementById('input-note').value.trim();
  const date = document.getElementById('input-date').value;

  if (!amount || amount <= 0) {
    alert('金額を正しく入力してください');
    return;
  }
  if (!date) {
    alert('日付を入力してください');
    return;
  }

  const transaction = {
    id: Date.now(),
    type: currentType,
    amount,
    category,
    note,
    date
  };

  transactions.unshift(transaction);
  save();
  render();
  closeModal();
}

// 削除処理
function deleteTransaction(id) {
  transactions = transactions.filter(t => t.id !== id);
  save();
  render();
}

// イベントリスナー
document.getElementById('add-btn').addEventListener('click', openModal);
document.getElementById('btn-cancel').addEventListener('click', closeModal);
document.getElementById('btn-save').addEventListener('click', saveTransaction);

document.getElementById('btn-expense').addEventListener('click', () => setType('expense'));
document.getElementById('btn-income').addEventListener('click', () => setType('income'));

modalOverlay.addEventListener('click', e => {
  if (e.target === modalOverlay) closeModal();
});

listEl.addEventListener('click', e => {
  const btn = e.target.closest('.tx-delete');
  if (btn) {
    if (confirm('この取引を削除しますか？')) {
      deleteTransaction(Number(btn.dataset.id));
    }
  }
});

filterMonth.addEventListener('change', render);
filterCategory.addEventListener('change', render);
filterType.addEventListener('change', render);

// Enterキーで保存
document.getElementById('input-amount').addEventListener('keydown', e => {
  if (e.key === 'Enter') saveTransaction();
});

// 初期描画
render();
