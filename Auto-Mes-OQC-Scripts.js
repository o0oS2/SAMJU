// ==UserScript==
// @name         Barcode Auto Re-paste (Ghi mã & Dán tự động)
// @namespace    barcode-auto-repaste
// @version      2.0
// @description  Nhận diện 3 ô theo TÊN NHÃN hiển thị (ổn định) thay vì theo id (do MUI tự sinh, dễ đổi khi bố cục trang thay đổi -> hay gây lỗi "mở web không chạy"): ô "Mã Lot bán thành phẩm" (ghi mã), ô "Tem bản vẽ" (lot id), ô "Mã Lot APP" (dán). Ghi mã khi bắn Enter vào 2 danh sách song song: (1) Phần 1 - dán tuần tự vào ô "Mã Lot APP", tự xóa sau khi dán hết; chỉ tự điền 11 ký tự đầu của lot id vào ô "Tem bản vẽ" khi ô đó đang TRỐNG (đã có dữ liệu thì không đụng vào), và chỉ dán các mã có 11 ký tự đầu trùng với nội dung hiện tại của ô "Tem bản vẽ" - mã nào không trùng sẽ bị bỏ qua (chờ tới khi ô đó đổi sang đúng lot id của nó); (2) Backup - lưu lại mọi mã mới, mã trùng với mã đã có trong Backup sẽ bị bỏ qua (không thêm vào cả 2 phần); nút dán tự động ở Backup chỉ dán các mã có 11 ký tự đầu trùng với nội dung hiện tại của ô "Tem bản vẽ" (nếu trống thì không dán), mỗi lần bấm dán lại từ đầu qua các mã khớp, không tự xóa sau khi dán, chỉ tự mất từng mã sau đúng 1h. Chỉ cho dán khi đang chọn đúng ô "Mã Lot APP". Panel tự ẩn/hiện theo ô đang focus: focus vào ô ghi mã chỉ hiện số mã đã lưu, ẩn nút Dán; focus vào ô dán mới hiện đầy đủ nút Dán, luôn ở dạng thu gọn.
// @author       you
// @match        http://192.168.9.102/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'bar_auto_repaste_list_v1';
  const BACKUP_KEY = 'bar_auto_repaste_backup_v1';
  const SETTINGS_KEY = 'bar_auto_repaste_settings_v1';
  const ACTIVITY_KEY = 'bar_auto_repaste_activity_v1';
  const ONE_HOUR_MS = 60 * 60 * 1000;

  const DELAY_MS = 500;
  const BACKUP_SWEEP_MS = 30 * 1000; // dò và xóa các mã backup đã đủ 1h mỗi 30s
  const COUNTDOWN_TICK_MS = 1000; // cập nhật đồng hồ đếm ngược mỗi 1s

  // Nhận diện 3 ô theo TÊN NHÃN hiển thị cạnh ô, thay vì theo id.
  // Lý do: id kiểu "mui-98" là do MUI tự đánh số theo thứ tự component render ra,
  // có thể đổi khác giữa các lần tải trang/điều hướng -> id cũ không còn đúng nữa,
  // script tìm không thấy ô và không chạy. Tên nhãn thì cố định, không đổi.
  const SCAN_LABEL_TEXT = 'Mã Lot bán thành phẩm'; // ô bắn barcode để ghi mã
  const LOTID_LABEL_TEXT = 'Tem bản vẽ'; // ô nhận 11 ký tự đầu của lot id
  const PASTE_LABEL_TEXT = 'Mã Lot APP'; // ô duy nhất được phép dán vào
  const LOTID_PREFIX_LEN = 11;

  let codes = GM_getValue(STORAGE_KEY, []); // Phần 1: [{value, pasted:boolean}] - tự xóa sau khi dán hết
  let backupCodes = GM_getValue(BACKUP_KEY, []); // Phần 2: [{value, ts, pasted:boolean}] - tự xóa sau 1h/mã
  let settings = GM_getValue(SETTINGS_KEY, {
    hotkey: 'F8',
  });
  let lastActivity = GM_getValue(ACTIVITY_KEY, Date.now());

  function save() {
    GM_setValue(STORAGE_KEY, codes);
    GM_setValue(BACKUP_KEY, backupCodes);
    GM_setValue(SETTINGS_KEY, settings);
  }

  function touchActivity() {
    lastActivity = Date.now();
    GM_setValue(ACTIVITY_KEY, lastActivity);
  }

  // ---------- Helper: đặt giá trị input kiểu tương thích React/Vue ----------
  function setNativeValue(element, value) {
    const proto = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fireEnter(element) {
    ['keydown', 'keypress', 'keyup'].forEach((type) => {
      const ev = new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      // Chrome không cho set keyCode/which qua constructor (luôn ra 0),
      // nhiều web cũ kiểm tra e.keyCode===13 nên phải ép thủ công.
      try {
        Object.defineProperty(ev, 'keyCode', { get: () => 13 });
        Object.defineProperty(ev, 'which', { get: () => 13 });
      } catch (err) {
        /* ignore nếu trình duyệt không cho ghi đè */
      }
      element.dispatchEvent(ev);
    });
  }

  function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    return tag === 'input' || tag === 'textarea' || el.isContentEditable;
  }

  function normalizeText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  // Tìm ô input theo TÊN NHÃN hiển thị (label) thay vì theo id, vì id do MUI tự sinh
  // và có thể đổi khác giữa các lần tải trang. Luôn dò lại DOM mới nhất mỗi lần gọi
  // (không cache) để không bao giờ bị "dính" vào một id/element cũ đã mất hiệu lực.
  function findFieldByLabel(labelText) {
    const labels = Array.from(document.querySelectorAll('label')).filter(
      (lbl) => normalizeText(lbl.textContent) === labelText
    );
    if (labels.length === 0) return null;

    // Trang có thể có nhiều ô trùng tên nhãn (VD: 1 ô lọc/tìm kiếm khác đặt tên y hệt
    // ô bắn mã). 3 ô mà tool này cần luôn là dạng "outlined" (ô có khung viền), khác
    // với ô lọc dạng "standard" (chỉ gạch chân) -> ưu tiên chọn label dạng outlined
    // trước để tránh bắt nhầm sang ô khác trùng tên.
    const outlined = labels.find((lbl) => lbl.classList.contains('MuiInputLabel-outlined'));
    const chosen = outlined || labels[0];

    const forId = chosen.getAttribute('for');
    if (forId) {
      const el = document.getElementById(forId);
      if (el) return el;
    }
    // Dự phòng: nếu label không có "for" hợp lệ, tìm input/textarea nằm trong
    // cùng khối MuiFormControl chứa label này.
    const wrap = chosen.closest('.MuiFormControl-root') || chosen.parentElement;
    if (wrap) {
      const inp = wrap.querySelector('input, textarea');
      if (inp) return inp;
    }
    return null;
  }

  function getScanInput() {
    return findFieldByLabel(SCAN_LABEL_TEXT);
  }
  function getLotIdInput() {
    return findFieldByLabel(LOTID_LABEL_TEXT);
  }
  function getPasteInput() {
    return findFieldByLabel(PASTE_LABEL_TEXT);
  }

  // Ghi nhớ ô input cuối cùng được focus, vì bấm nút trong panel sẽ làm ô input
  // bị mất focus (document.activeElement đổi sang cái nút) -> phải nhớ lại từ trước.
  let lastEditable = null;
  document.addEventListener(
    'focusin',
    (e) => {
      if (isEditable(e.target) && !panel.contains(e.target)) {
        lastEditable = e.target;
        updateTargetLabel();
      }
    },
    true
  );

  // ---------- Tự ẩn/hiện panel theo ô đang focus ----------
  // Focus vào ô "Mã Lot bán thành phẩm" (ghi mã) -> hiện panel ở chế độ "scan":
  //   chỉ hiện số mã đã lưu, ẩn nút Dán (vì lúc này chưa được phép dán).
  // Focus vào ô "Mã Lot APP" (dán) -> hiện panel đầy đủ, có nút Dán như bình thường.
  // Focus ra chỗ khác -> ẩn hẳn panel. Nếu đã tắt tay bằng nút X thì luôn ẩn tới khi F5.
  document.addEventListener(
    'focusin',
    (e) => {
      const el = e.target;
      if (!el || panel.contains(el)) return; // thao tác trong panel không làm ẩn panel
      if (el === getPasteInput()) {
        showPanel('full');
      } else if (el === getScanInput()) {
        showPanel('scan');
      } else {
        hidePanel();
      }
    },
    true
  );

  function showPanel(mode) {
    panel.style.display = 'block';
    setPanelMode(mode);
  }
  function hidePanel() {
    panel.style.display = 'none';
  }

  // "full": hiện đầy đủ (nút Dán + nút thu gọn/mở rộng) - dùng khi đang ở ô #mui-98.
  // "scan": chỉ hiện số mã đã lưu, ẩn nút Dán và thu nhỏ panel vừa khít nội dung - dùng khi
  // đang ghi mã ở ô #mui-5, vì lúc này không được phép dán (pasteValueToTarget sẽ tự chặn,
  // nhưng ẩn nút đi cho gọn giao diện và đỡ bấm nhầm).
  function setPanelMode(mode) {
    const autoBtn = $('#bar-auto-btn');
    if (!autoBtn) return; // panel UI chưa dựng xong
    if (mode === 'scan') {
      autoBtn.style.display = 'none';
      if (!minimized) {
        minimized = true;
      }
      applyMinimized();
      // Ép panel thu nhỏ khít theo nội dung (chỉ còn số đếm + nút thu gọn),
      // thay vì giữ nguyên bề rộng cố định 150px như lúc còn nút Dán.
      panel.style.width = 'fit-content';
      panel.style.minWidth = '0';
    } else {
      autoBtn.style.display = '';
      panel.style.minWidth = '';
      applyMinimized(); // trả lại bề rộng cố định (150px/300px) theo trạng thái thu gọn/mở rộng
    }
  }

  function describeEl(el) {
    if (!el) return '(chưa chọn ô nào)';
    const name = el.name || el.id || el.placeholder || el.getAttribute('aria-label');
    return name ? `<${el.tagName.toLowerCase()}> "${name}"` : `<${el.tagName.toLowerCase()}>`;
  }
  function updateTargetLabel() {
    const lbl = document.getElementById('bar-target-label');
    if (lbl) lbl.textContent = describeEl(getTargetEl());
  }

  function getTargetEl() {
    if (lastEditable && document.contains(lastEditable)) return lastEditable;
    if (isEditable(document.activeElement) && !panel.contains(document.activeElement)) {
      return document.activeElement;
    }
    return null;
  }

  // ---------- GIAI ĐOẠN 1: ghi mã khi bắn Enter (ghi song song vào cả 2 phần) ----------
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter') return;
      const el = document.activeElement;
      if (!isEditable(el)) return;

      const val = (el.isContentEditable ? el.innerText : el.value || '').trim();
      if (!val) return;

      const exists = backupCodes.some((c) => c.value === val);
      if (exists) {
        flashPanel('#ff9800', `Mã "${val}" đã có trong Backup, bỏ qua trùng`);
        return;
      }
      codes.push({ value: val, pasted: false });
      backupCodes.push({ value: val, ts: Date.now(), pasted: false });
      save();
      touchActivity();
      renderList();
      renderBackup();
      flashPanel('#4caf50', `Đã ghi: ${val}`);
    },
    true
  );

  // ---------- Helper dùng chung: dán 1 giá trị cụ thể vào ô đang focus ----------
  // Bắt buộc ô đang chọn phải đúng là ô "Mã Lot APP", nếu không sẽ báo lỗi và không dán.
  function pasteValueToTarget(value) {
    const target = getTargetEl();
    if (!target) {
      flashPanel('#f44336', `Hãy click vào ô "${PASTE_LABEL_TEXT}" trước!`);
      return false;
    }
    if (target !== getPasteInput()) {
      flashPanel('#f44336', `Chỉ được dán vào ô "${PASTE_LABEL_TEXT}"! Đang chọn ô khác.`);
      return false;
    }
    try {
      if (target.isContentEditable) {
        target.innerText = value;
        target.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        setNativeValue(target, value);
      }
      fireEnter(target);
      target.focus();
    } catch (err) {
      flashPanel('#f44336', 'Lỗi khi dán, đã dừng: ' + err.message);
      return false;
    }
    return true;
  }

  // Dán trực tiếp 1 giá trị vào 1 phần tử cụ thể, không qua kiểm tra focus (dùng cho ô "Tem bản vẽ").
  function pasteValueToElement(el, value) {
    if (!el) return false;
    try {
      if (el.isContentEditable) {
        el.innerText = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        setNativeValue(el, value);
      }
      fireEnter(el);
    } catch (err) {
      return false;
    }
    return true;
  }

  // ---------- GIAI ĐOẠN 2: dán tuần tự từ Phần 1 (tự xóa sau khi dán hết - như cũ) ----------
  function pasteNext() {
    const target = getTargetEl();
    if (!target) {
      flashPanel('#f44336', `Hãy click vào ô "${PASTE_LABEL_TEXT}" trước!`);
      return false;
    }
    if (target !== getPasteInput()) {
      flashPanel('#f44336', `Chỉ được dán vào ô "${PASTE_LABEL_TEXT}"! Đang chọn ô khác.`);
      return false;
    }

    const remaining = codes.filter((c) => !c.pasted);
    if (remaining.length === 0) {
      flashPanel('#f44336', 'Hết mã để dán');
      return false;
    }

    // Chỉ tự điền 11 ký tự đầu của lot id vào ô "Tem bản vẽ" khi ô đó đang TRỐNG.
    // Nếu ô đó đã có dữ liệu thì giữ nguyên, không ghi đè.
    if (!getLotIdValue()) {
      const prefix = remaining[0].value.slice(0, LOTID_PREFIX_LEN);
      const lotEl = getLotIdInput();
      if (lotEl) pasteValueToElement(lotEl, prefix);
    }

    // So sánh 11 ký tự đầu của từng mã với nội dung hiện tại của ô "Tem bản vẽ":
    // trùng thì dán, không trùng thì bỏ qua (chờ ô đó đổi sang đúng lot id).
    const lotVal = getLotIdValue();
    if (!lotVal) {
      flashPanel('#f44336', `Ô "${LOTID_LABEL_TEXT}" đang trống, không dán được`);
      return false;
    }
    const currentPrefix = lotVal.slice(0, LOTID_PREFIX_LEN);
    const item = remaining.find((c) => c.value.slice(0, LOTID_PREFIX_LEN) === currentPrefix);
    if (!item) {
      flashPanel('#ff9800', `Không có mã nào khớp 11 ký tự đầu với "${LOTID_LABEL_TEXT}", đã bỏ qua`);
      return false;
    }

    const ok = pasteValueToTarget(item.value);
    if (!ok) return false;
    item.pasted = true;
    save();
    touchActivity();
    renderList();
    return true;
  }

  let autoTimer = null;
  function startAuto() {
    const t = getTargetEl();
    if (!t || t !== getPasteInput()) {
      flashPanel('#f44336', `Hãy click vào ô "${PASTE_LABEL_TEXT}" trước rồi bấm lại!`);
      return;
    }
    stopAuto();
    autoTimer = setInterval(() => {
      const ok = pasteNext();
      if (!ok) {
        stopAuto();
        if (codes.length > 0 && codes.every((c) => c.pasted)) {
          codes = [];
          save();
          renderList();
          flashPanel('#4caf50', 'Đã dán xong & tự xóa danh sách (Phần 1)');
        }
      }
    }, DELAY_MS);
    updateAutoBtn(true);
  }
  function stopAuto() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
    updateAutoBtn(false);
  }
  function toggleAuto() {
    if (autoTimer) stopAuto();
    else startAuto();
  }

  // Phím tắt dán từng mã một (luôn thao tác trên Phần 1, giữ nguyên như cũ)
  document.addEventListener('keydown', (e) => {
    if (e.key === settings.hotkey) {
      e.preventDefault();
      pasteNext();
    }
  });

  // ---------- Tự xóa toàn bộ Phần 1 nếu để quá 1 tiếng không hoạt động (giữ như cũ) ----------
  setInterval(() => {
    if (codes.length > 0 && Date.now() - lastActivity > ONE_HOUR_MS) {
      codes = [];
      save();
      touchActivity();
      renderList();
      flashPanel('#ff9800', 'Quá 1 tiếng không dán, đã tự xóa danh sách (Phần 1)');
    }
  }, 60 * 1000);

  // ---------- Phần 2 (Backup): tự xóa TỪNG mã khi mã đó đủ 1 tiếng, mã chưa đủ vẫn giữ lại ----------
  setInterval(() => {
    const before = backupCodes.length;
    backupCodes = backupCodes.filter((c) => Date.now() - c.ts < ONE_HOUR_MS);
    if (backupCodes.length !== before) {
      save();
      renderBackup();
    }
  }, BACKUP_SWEEP_MS);

  // Đọc nội dung hiện tại của ô "Tem bản vẽ" (lot id) để lọc mã khớp trước khi dán tự động Backup
  function getLotIdValue() {
    const el = getLotIdInput();
    if (!el) return '';
    const raw = el.isContentEditable ? el.innerText : el.value || '';
    return raw.trim();
  }

  // ---------- Dán tự động cho Backup: KHÔNG đụng ô "Tem bản vẽ", dán xong KHÔNG xóa ----------
  // Chỉ dán những mã có 11 ký tự đầu trùng với nội dung hiện tại của ô "Tem bản vẽ".
  // Nếu ô đó đang trống thì không dán mã nào cả.
  // Mỗi lần bấm "Dán tự động" sẽ chạy lại từ đầu qua toàn bộ các mã khớp (kể cả mã
  // đã từng xanh trước đó), dán tới đâu xanh tới đó theo đúng thứ tự đã quét.
  let backupAutoQueue = [];
  let backupAutoQueueIndex = 0;

  function pasteNextBackup() {
    const target = getTargetEl();
    if (!target) {
      flashPanel('#f44336', `Hãy click vào ô "${PASTE_LABEL_TEXT}" trước!`);
      return false;
    }
    if (target !== getPasteInput()) {
      flashPanel('#f44336', `Chỉ được dán vào ô "${PASTE_LABEL_TEXT}"! Đang chọn ô khác.`);
      return false;
    }
    if (backupAutoQueueIndex >= backupAutoQueue.length) {
      flashPanel('#4caf50', 'Backup: đã dán xong các mã khớp lot id');
      return false;
    }
    const item = backupAutoQueue[backupAutoQueueIndex];
    const ok = pasteValueToTarget(item.value);
    if (!ok) return false;
    item.pasted = true;
    backupAutoQueueIndex++;
    save();
    touchActivity();
    renderBackup();
    return true;
  }

  let backupAutoTimer = null;
  function startBackupAuto() {
    const t = getTargetEl();
    if (!t || t !== getPasteInput()) {
      flashPanel('#f44336', `Hãy click vào ô "${PASTE_LABEL_TEXT}" trước rồi bấm lại!`);
      return;
    }
    const lotVal = getLotIdValue();
    if (!lotVal) {
      flashPanel('#f44336', `Ô "${LOTID_LABEL_TEXT}" đang trống, không dán được`);
      return;
    }
    const prefix = lotVal.slice(0, LOTID_PREFIX_LEN);
    const matches = backupCodes.filter((c) => c.value.slice(0, LOTID_PREFIX_LEN) === prefix);
    if (matches.length === 0) {
      flashPanel('#f44336', `Backup: không có mã nào khớp 11 ký tự đầu với "${LOTID_LABEL_TEXT}"`);
      return;
    }
    stopBackupAuto();
    backupAutoQueue = matches;
    backupAutoQueueIndex = 0;
    backupAutoTimer = setInterval(() => {
      const ok = pasteNextBackup();
      if (!ok) stopBackupAuto();
    }, DELAY_MS);
    updateBackupAutoBtn(true);
  }
  function stopBackupAuto() {
    if (backupAutoTimer) clearInterval(backupAutoTimer);
    backupAutoTimer = null;
    updateBackupAutoBtn(false);
  }
  function toggleBackupAuto() {
    if (backupAutoTimer) stopBackupAuto();
    else startBackupAuto();
  }

  // ---------- UI ----------
  const panel = document.createElement('div');
  panel.style.cssText = `
    position: fixed; bottom: 16px; left: 16px; width: 280px;
    background: linear-gradient(180deg, #eaf5ff 0%, #dcedfb 100%);
    color: #1c3d5a; font: 13px/1.4 sans-serif;
    border: 1px solid #bcdcf5;
    border-radius: 12px; box-shadow: 0 4px 16px rgba(30,90,140,.25);
    z-index: 2147483647; padding: 8px; user-select: none;
    display: none;
  `;
  panel.innerHTML = `
    <style>
      #bar-topbar button, #bar-body button {
        background: #5aa9e6; color: #fff; border: none; border-radius: 6px;
        padding: 4px 6px; cursor: pointer; font: inherit;
      }
      #bar-topbar button:hover, #bar-body button:hover { background: #4791d1; }
      #bar-topbar button:disabled { background: #a9cbe8; cursor: default; }
      #bar-body input[type="number"], #bar-body input[type="text"] {
        background: #fff; color: #1c3d5a; border: 1px solid #bcdcf5;
        border-radius: 5px; padding: 2px 4px;
      }
      #bar-body input[type="checkbox"] { accent-color: #5aa9e6; }
      #bar-min:hover { color: #4791d1; }
      .bar-section-title { font-weight: bold; color: #1c6fb0; margin: 4px 0 4px; }
      .bar-row { display:flex; justify-content:space-between; align-items:center; padding:2px 0; gap:4px; }
      .bar-row-val { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
      .bar-mini-btn {
        background:#5aa9e6; color:#fff; border:none; border-radius:5px;
        padding:1px 6px; cursor:pointer; font:11px/1.4 sans-serif; flex-shrink:0;
      }
      .bar-mini-btn:hover { background:#4791d1; }
      .bar-remain { color:#888; font-size:11px; flex-shrink:0; min-width:34px; text-align:right; }
      .bar-del { cursor:pointer; color:#f44336; flex-shrink:0; }
    </style>
    <div id="bar-topbar" style="cursor:move; display:flex; align-items:center; gap:6px;">
      <span id="bar-count" style="font-weight:bold; min-width:16px; text-align:center; color:#1c6fb0;">0</span>
      <button id="bar-auto-btn" style="flex:1; padding:2px 4px;">▶ Dán</button>
      <span id="bar-min" style="cursor:pointer; padding:0 4px; font-weight:bold; color:#1c6fb0;">+</span>
    </div>
    <div id="bar-body" style="display:none; margin-top:8px;">
      <div id="bar-status" style="color:#3d6f96; margin-bottom:6px;">Sẵn sàng.</div>

      <div class="bar-section-title">① Danh sách dán (tự xóa sau khi dán hết)</div>
      <div style="max-height:110px; overflow-y:auto; border:1px solid #bcdcf5; background:#f4faff; border-radius:6px; padding:4px; margin-bottom:6px;" id="bar-list"></div>
      <div style="display:flex; gap:6px; margin-bottom:6px;">
        <button id="bar-clear" style="flex:1;">Xóa hết Phần 1</button>
      </div>
      <div style="color:#8a6d3b; font-size:11px; margin-bottom:10px;">Chỉ tự điền lot id vào ô "${LOTID_LABEL_TEXT}" khi ô đó đang trống. Chỉ dán mã có 11 ký tự đầu trùng với ô "${LOTID_LABEL_TEXT}", mã không khớp sẽ tạm bỏ qua.</div>

      <div class="bar-section-title">② Backup (mỗi mã tự xóa sau 1 giờ)</div>
      <div style="max-height:130px; overflow-y:auto; border:1px solid #bcdcf5; background:#fff8ee; border-radius:6px; padding:4px; margin-bottom:6px;" id="bar-backup-list"></div>
      <div style="display:flex; gap:6px; margin-bottom:6px;">
        <button id="bar-backup-auto-btn" style="flex:1;">▶ Dán tự động</button>
        <button id="bar-backup-clear" style="flex:1;">Xóa hết</button>
      </div>
      <div style="color:#8a6d3b; font-size:11px; margin-bottom:6px;">Dán tự động ở Backup chỉ dán mã có 11 ký tự đầu trùng với ô "${LOTID_LABEL_TEXT}" (nếu ô đó trống sẽ không dán). Dán xong KHÔNG xóa, chỉ tự mất sau đúng 1h kể từ lúc quét.</div>

      <div style="color:#3d6f96;">Chỉ dán được khi đang chọn ô "${PASTE_LABEL_TEXT}". Phím tắt dán 1 mã (Phần 1): <b id="bar-hotkey-label"></b></div>
    </div>
  `;
  document.documentElement.appendChild(panel);

  const $ = (sel) => panel.querySelector(sel);
  $('#bar-hotkey-label').textContent = settings.hotkey;

  $('#bar-clear').addEventListener('click', () => {
    if (!confirm('Xóa toàn bộ danh sách Phần 1 (danh sách dán)?')) return;
    codes = [];
    save();
    touchActivity();
    renderList();
  });
  $('#bar-backup-clear').addEventListener('click', () => {
    if (!confirm('Xóa toàn bộ Backup (Phần 2)? Các mã đang chờ hết 1h sẽ mất luôn.')) return;
    backupCodes = [];
    save();
    renderBackup();
  });
  $('#bar-auto-btn').addEventListener('click', toggleAuto);
  $('#bar-backup-auto-btn').addEventListener('click', toggleBackupAuto);

  let minimized = true;
  function applyMinimized() {
    $('#bar-body').style.display = minimized ? 'none' : 'block';
    $('#bar-min').textContent = minimized ? '+' : '–';
    panel.style.width = minimized ? '150px' : '300px';
  }
  $('#bar-min').addEventListener('click', () => {
    minimized = !minimized;
    applyMinimized();
  });

  // Kéo thả panel
  (function makeDraggable() {
    const header = $('#bar-topbar');
    let dragging = false, offX = 0, offY = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target.id === 'bar-auto-btn' || e.target.id === 'bar-min') return;
      dragging = true;
      offX = e.clientX - panel.getBoundingClientRect().left;
      offY = e.clientY - panel.getBoundingClientRect().top;
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = e.clientX - offX + 'px';
      panel.style.top = e.clientY - offY + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => (dragging = false));
  })();

  function updateAutoBtn(running) {
    $('#bar-auto-btn').textContent = running ? '⏳...' : '▶ Dán';
  }
  function updateBackupAutoBtn(running) {
    $('#bar-backup-auto-btn').textContent = running ? '⏳...' : '▶ Dán tự động';
  }

  // ---------- Render Phần 1 ----------
  function renderList() {
    const list = $('#bar-list');
    if (codes.length === 0) {
      list.innerHTML = '<i style="color:#777;">Chưa có mã nào</i>';
    } else {
      list.innerHTML = codes
        .map(
          (c, i) =>
            `<div class="bar-row" style="${c.pasted ? 'color:#4caf50;' : ''}">
              <span class="bar-row-val">${i + 1}. ${escapeHtml(c.value)} ${c.pasted ? '✓' : ''}</span>
              <span class="bar-del" data-del="${i}">✕</span>
            </div>`
        )
        .join('');
      list.querySelectorAll('[data-del]').forEach((el) => {
        el.addEventListener('click', () => {
          codes.splice(parseInt(el.getAttribute('data-del'), 10), 1);
          save();
          renderList();
        });
      });
    }
    const remain = codes.filter((c) => !c.pasted).length;
    const pastedCount = codes.length - remain;
    $('#bar-status').textContent = `Phần 1 - Tổng: ${codes.length} | Chưa dán: ${remain}`;
    $('#bar-count').textContent = pastedCount > 0 ? `${pastedCount}/${codes.length}` : `${codes.length}`;
  }

  // ---------- Render Phần 2 (Backup) ----------
  function formatRemain(ms) {
    if (ms <= 0) return '0p';
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}p${s.toString().padStart(2, '0')}`;
  }

  function renderBackup() {
    const list = $('#bar-backup-list');
    if (backupCodes.length === 0) {
      list.innerHTML = '<i style="color:#777;">Chưa có mã nào</i>';
      return;
    }
    // mới nhất lên trên cho dễ tìm mã vừa dán nhầm
    const rows = backupCodes
      .map((c, i) => ({ c, i }))
      .sort((a, b) => b.c.ts - a.c.ts);

    list.innerHTML = rows
      .map(
        ({ c, i }) =>
          `<div class="bar-row" style="${c.pasted ? 'color:#4caf50;' : ''}">
            <span class="bar-row-val">${escapeHtml(c.value)} ${c.pasted ? '✓' : ''}</span>
            <span class="bar-remain" data-ts="${c.ts}"></span>
            <span class="bar-del" data-bdel="${i}">✕</span>
          </div>`
      )
      .join('');

    list.querySelectorAll('[data-bdel]').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.getAttribute('data-bdel'), 10);
        backupCodes.splice(idx, 1);
        save();
        renderBackup();
      });
    });

    updateBackupCountdowns();
  }

  // Cập nhật đồng hồ đếm ngược của backup mỗi giây mà không phải render lại toàn bộ list
  function updateBackupCountdowns() {
    const spans = $('#bar-backup-list').querySelectorAll('.bar-remain');
    spans.forEach((sp) => {
      const ts = parseInt(sp.getAttribute('data-ts'), 10);
      const remain = ONE_HOUR_MS - (Date.now() - ts);
      sp.textContent = formatRemain(remain);
    });
  }
  setInterval(updateBackupCountdowns, COUNTDOWN_TICK_MS);

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[m]));
  }

  let flashTimer = null;
  function flashPanel(color, msg) {
    const status = $('#bar-status');
    status.style.color = color;
    status.textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      status.style.color = '#3d6f96';
      renderList();
    }, 1200);
  }

  renderList();
  renderBackup();
  updateTargetLabel();
  applyMinimized();

  // Web dạng SPA (chuyển trang không load lại toàn bộ) đôi khi tự dọn dẹp
  // các phần tử lạ không do nó tạo ra -> kiểm tra định kỳ, tự chèn lại panel nếu bị mất.
  setInterval(() => {
    if (!document.documentElement.contains(panel)) {
      document.documentElement.appendChild(panel);
    }
  }, 1000);
})();
