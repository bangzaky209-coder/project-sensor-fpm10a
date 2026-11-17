"use strict";

/* ===== 4. VARIABEL SISTEM ===== */
let systemStatus = "Standby";      // Standby | Scanning | Verifying | Enrolling | Error
let sensorStatus = "Ready";        // Ready | Scanning | Success | Failed
let fingerprintID = null;          // Integer / Null
let userName = "-";
let accessGranted = false;
let doorStatus = "Locked";         // Locked | Unlocking | Open | Locking
let lockStatus = true;             // true = pengunci aktif (terkunci)
let solenoidStatus = false;        // true = solenoid mendapat daya (pengunci dilepas)
let scanDuration = 0;              // milidetik
let lastAccessTime = "-";
let successfulAccess = 0;
let failedAccess = 0;
let accessLogs = [];
let doorOpenDuration = 5000;       // milidetik
let autoLockEnabled = true;

/* Database Pengguna Dinamis */
let USERS = { 
  1: "Pengguna Simulasi A", 
  2: "Pengguna Simulasi B", 
  3: "Pengguna Simulasi C" 
};

/* variabel bantu */
let hasAuth = false;               
let busy = false;
let doorCountdown = null;
let lcdLine1 = "SMART LOCKER", lcdLine2 = "Pintu Terkunci";
let ledGreen = false, ledRed = false;
let timers = [];
let ARDUINO_STATUS = "Simulated";   // Online | Offline | Simulated
let liveMode = false, port = null, reader = null, closedPromise = null, liveScanStart = 0, pendingId = null;
const SCAN_MS = 2000, VERIFY_MS = 800, ENROLL_MS = 3000, UNLOCK_MS = 1200, LOCK_MS = 1200;

const $ = (id) => document.getElementById(id);

function later(fn, ms) { const t = setTimeout(fn, ms); timers.push(t); return t; }
function clearTimers() { timers.forEach(clearTimeout); timers = []; clearInterval(doorCountdown); doorCountdown = null; }
function tone(el, t) { el.dataset.tone = t; }

/* ===== RENDER ===== */
function render() {
  const sysTone = { Standby: "idle", Scanning: "warn", Verifying: "warn", Enrolling: "warn", Error: "bad" }[systemStatus];
  tone($("sysIndicator"), sysTone);
  $("sysText").textContent = systemStatus;

  $("cArduino").textContent = ARDUINO_STATUS;
  tone($("cArduino"), { Online: "ok", Offline: "bad", Simulated: "warn" }[ARDUINO_STATUS]);
  $("btnConnect").textContent = liveMode ? "Putuskan Arduino" : "Hubungkan Arduino";
  $("serialLog").hidden = !liveMode;
  $("hwNote").textContent = liveMode
    ? "Mode Live: terhubung ke Arduino lewat Web Serial (9600 baud). Status pada halaman ini mengikuti data serial dari perangkat."
    : "Mode simulasi: perangkat keras belum terhubung secara langsung. Seluruh komponen di halaman ini hanya simulasi di browser.";
  $("cSensor").textContent = sensorStatus;
  tone($("cSensor"), { Ready: "ok", Scanning: "warn", Success: "ok", Failed: "bad" }[sensorStatus]);
  $("cAuth").textContent = hasAuth ? (accessGranted ? "Granted" : "Denied") : "Belum ada";
  tone($("cAuth"), hasAuth ? (accessGranted ? "ok" : "bad") : "idle");
  $("cDoor").textContent = doorStatus;
  tone($("cDoor"), { Locked: "idle", Unlocking: "warn", Open: "ok", Locking: "warn" }[doorStatus]);
  $("cLock").textContent = lockStatus ? "Locked" : "Unlocked";
  tone($("cLock"), lockStatus ? "idle" : "ok");
  $("cOk").textContent = successfulAccess;
  $("cFail").textContent = failedAccess;
  $("cLast").textContent = lastAccessTime;

  $("sensorBox").dataset.state = sensorStatus;
  $("scene").dataset.door = doorStatus;
  $("dDoor").textContent = doorStatus;
  $("dLock").textContent = lockStatus ? "Locked" : "Unlocked";
  $("dSol").textContent = solenoidStatus ? "Aktif (berdaya, pengunci dilepas)" : "Nonaktif (pengunci menahan pintu)";
  tone($("dSol"), solenoidStatus ? "ok" : "idle");

  $("ledG").classList.toggle("on", ledGreen);
  $("ledR").classList.toggle("on", ledRed);
  $("lcd1").textContent = lcdLine1;
  $("lcd2").textContent = lcdLine2;

  const err = systemStatus === "Error";
  $("errBanner").hidden = !err;
  $("btnScan").disabled = liveMode || busy || err || doorStatus !== "Locked";
  $("btnEnroll").disabled = liveMode || busy || err || doorStatus !== "Locked";
  $("btnManual").disabled = doorStatus !== "Open";
  $("chkErr").disabled = liveMode || busy || doorStatus !== "Locked";
  $("selUser").disabled = liveMode || document.querySelector("input[name=scn]:checked").value !== "valid";
  document.querySelectorAll("input[name=scn]").forEach((x) => (x.disabled = liveMode));
  $("chkAuto").disabled = liveMode;

  const r = $("result");
  if (!hasAuth) {
    tone(r, "idle"); $("rTitle").textContent = "Belum ada pemindaian";
  } else {
    tone(r, accessGranted ? "ok" : "bad");
    $("rTitle").textContent = accessGranted ? "Access Granted: akses diterima" : "Access Denied: akses ditolak";
  }
  $("rId").textContent = fingerprintID === null ? "-" : fingerprintID;
  $("rName").textContent = userName;
  $("rDur").textContent = scanDuration ? scanDuration + " ms" : "-";
}

function setLcd(a, b) { lcdLine1 = a; lcdLine2 = b; }
function phase(text) { $("phase").textContent = text; }

function beep(times) {
  const led = $("ledB");
  let i = 0;
  (function step() {
    if (i >= times) return;
    led.classList.add("on");
    later(() => { led.classList.remove("on"); i++; later(step, 150); }, 200);
  })();
}

function animateBar(ms) {
  const bar = $("bar");
  bar.style.transition = "none"; bar.style.width = "0";
  void bar.offsetWidth;
  bar.style.transition = "width " + ms + "ms linear"; bar.style.width = "100%";
}
function resetBar() { const b = $("bar"); b.style.transition = "none"; b.style.width = "0"; }

/* ===== PENGISIAN DROPDOWN USER ===== */
function updateDropdownUsers() {
  const sel = $("selUser");
  sel.innerHTML = "";
  Object.keys(USERS).forEach((id) => {
    const o = document.createElement("option");
    o.value = id; o.textContent = "ID " + id + " - " + USERS[id];
    sel.appendChild(o);
  });
}

/* ===== LOG ===== */
function renderLog() {
  const body = $("logBody");
  body.innerHTML = "";
  if (accessLogs.length === 0) {
    body.innerHTML = '<tr><td class="empty" colspan="6">Belum ada riwayat. Jalankan Scan Fingerprint atau Daftarkan Jari pada panel simulasi.</td></tr>';
    return;
  }
  accessLogs.forEach((l) => {
    const tr = document.createElement("tr");
    [l.no, l.time, l.id, l.name, l.result, l.status].forEach((v, i) => {
      const td = document.createElement("td");
      td.textContent = v;
      if (i === 4) td.className = l.result === "Granted" || l.result === "Enrolled" ? "granted" : "denied";
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
}

function addLog(result, statusText) {
  accessLogs.unshift({
    no: accessLogs.length + 1,
    time: lastAccessTime,
    id: fingerprintID === null ? "-" : fingerprintID,
    name: userName,
    result: result,
    status: statusText
  });
  renderLog();
}

/* ===== ALUR SIMULASI: SCAN & VERIFIKASI ===== */
function startScan() {
  if (busy || systemStatus === "Error" || doorStatus !== "Locked") return;
  busy = true;
  const t0 = performance.now();
  const scenario = document.querySelector("input[name=scn]:checked").value;
  const chosenId = Number($("selUser").value);

  systemStatus = "Scanning"; sensorStatus = "Scanning";
  setLcd("Membaca Jari...", "");
  phase("Memindai sidik jari...");
  animateBar(SCAN_MS + VERIFY_MS);
  render();

  later(() => {
    systemStatus = "Verifying";
    phase("Memverifikasi sidik jari...");
    render();
  }, SCAN_MS);

  later(() => {
    scanDuration = Math.round(performance.now() - t0);
    lastAccessTime = new Date().toLocaleString("id-ID");
    hasAuth = true;
    systemStatus = "Standby";
    if (scenario === "valid") grant(chosenId); else deny();
  }, SCAN_MS + VERIFY_MS);
}

function grant(id) {
  accessGranted = true;
  fingerprintID = id;
  userName = USERS[id] || ("Pengguna ID " + id);
  sensorStatus = "Success";
  successfulAccess++;
  ledGreen = true; ledRed = false;
  setLcd("AKSES DITERIMA", "Loker Terbuka");
  phase("Sidik jari cocok. Pengunci dilepas.");
  beep(1);
  solenoidStatus = true; lockStatus = false; doorStatus = "Unlocking";
  addLog("Granted", "Unlocking / Unlocked");
  render();

  later(openDoor, UNLOCK_MS);
}

function deny() {
  accessGranted = false;
  fingerprintID = null;
  userName = "-";
  sensorStatus = "Failed";
  failedAccess++;
  ledGreen = false; ledRed = true;
  setLcd("AKSES DITOLAK", "Jari Tidak Cocok");
  phase("Sidik jari tidak terdaftar. Pintu tetap terkunci.");
  beep(2);
  addLog("Denied", "Locked / Locked");
  render();

  later(() => {
    ledRed = false; sensorStatus = "Ready";
    setLcd("SMART LOCKER", "Tempelkan Jari");
    phase("Sensor siap. Pilih sidik jari lalu tekan Scan Fingerprint.");
    resetBar(); busy = false;
    render();
  }, 1500);
}

/* ===== ALUR FITUR BARU: MENDAFTARKAN SIDIK JARI & ID PENGGUNA BARU ===== */
function startEnrollment() {
  if (busy || systemStatus === "Error" || doorStatus !== "Locked") return;
  
  const newName = prompt("Masukkan nama untuk pengguna baru sidik jari:");
  if (!newName || newName.trim() === "") return;

  // Tentukan ID baru secara otomatis (angka setelah ID terakhir)
  const existingIds = Object.keys(USERS).map(Number);
  const newId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;

  busy = true;
  const t0 = performance.now();
  systemStatus = "Enrolling"; 
  sensorStatus = "Scanning";
  setLcd("DAFTARKAN JARI", "Tempelkan 2x");
  phase("Letakkan jari pada sensor untuk pendaftaran ID " + newId + "...");
  animateBar(ENROLL_MS);
  render();

  if (liveMode) {
    // Kirim perintah registrasi ke Arduino jika menggunakan mode live
    sendSerial("ENROLL:" + newId);
  }

  later(() => {
    scanDuration = Math.round(performance.now() - t0);
    lastAccessTime = new Date().toLocaleString("id-ID");
    hasAuth = true;
    accessGranted = true;
    systemStatus = "Standby";
    sensorStatus = "Success";
    
    // Simpan ke database pengguna lokal
    USERS[newId] = newName.trim();
    updateDropdownUsers();
    $("selUser").value = newId;

    fingerprintID = newId;
    userName = USERS[newId];
    successfulAccess++;
    ledGreen = true; ledRed = false;
    
    setLcd("PENDAFTARAN SUKSES", "ID: " + newId);
    phase("Sidik jari berhasil didaftarkan dengan ID " + newId + " (" + userName + ").");
    beep(1);
    
    addLog("Enrolled", "Pendaftaran ID Baru Berhasil");
    render();

    later(() => {
      ledGreen = false; sensorStatus = "Ready";
      setLcd("SMART LOCKER", "Tempelkan Jari");
      phase("Sensor siap. Pilih sidik jari lalu tekan Scan Fingerprint.");
      resetBar(); busy = false;
      render();
    }, 2000);
  }, ENROLL_MS);
}

function openDoor() {
  doorStatus = "Open";
  phase("Pintu terbuka.");
  let remaining = doorOpenDuration;
  const tick = 200;
  $("dOpen").textContent = (remaining / 1000).toFixed(1) + " dtk";
  doorCountdown = setInterval(() => {
    if (!autoLockEnabled) { $("dOpen").textContent = "Menunggu tombol kunci"; return; }
    remaining -= tick;
    $("dOpen").textContent = Math.max(remaining, 0) / 1000 + " dtk";
    if (remaining <= 0) { clearInterval(doorCountdown); doorCountdown = null; closeDoor(); }
  }, tick);
  render();
}

function closeDoor() {
  if (doorStatus !== "Open") return;
  clearInterval(doorCountdown); doorCountdown = null;
  doorStatus = "Locking";
  $("dOpen").textContent = "-";
  phase("Pintu menutup dan mengunci...");
  render();
  later(() => {
    doorStatus = "Locked"; lockStatus = true; solenoidStatus = false;
    ledGreen = false; sensorStatus = "Ready";
    setLcd("SMART LOCKER", "Pintu Terkunci");
    phase("Pintu terkunci. Sensor siap.");
    resetBar(); busy = false;
    render();
  }, LOCK_MS);
}

/* ===== ERROR SENSOR ===== */
function toggleError() {
  if ($("chkErr").checked) {
    systemStatus = "Error"; sensorStatus = "Failed";
    setLcd("Sensor Error", "Cek Kabel");
    phase("Error sensor. Akses baru tidak diberikan.");
  } else {
    systemStatus = "Standby"; sensorStatus = "Ready";
    setLcd("SMART LOCKER", "Tempelkan Jari");
    phase("Sensor siap. Pilih sidik jari lalu tekan Scan Fingerprint.");
  }
  render();
}

/* ===== RESET & HAPUS LOG ===== */
function resetSystem() {
  if (liveMode) { 
    successfulAccess = 0; failedAccess = 0; accessLogs = []; hasAuth = false;
    fingerprintID = null; userName = "-"; scanDuration = 0; lastAccessTime = "-";
    renderLog(); render(); return;
  }
  clearTimers();
  systemStatus = "Standby"; sensorStatus = "Ready"; fingerprintID = null; userName = "-";
  accessGranted = false; doorStatus = "Locked"; lockStatus = true; solenoidStatus = false;
  scanDuration = 0; lastAccessTime = "-"; successfulAccess = 0; failedAccess = 0;
  accessLogs = []; hasAuth = false; busy = false; ledGreen = false; ledRed = false;
  $("ledB").classList.remove("on");
  $("chkErr").checked = false;
  $("dOpen").textContent = "-";
  setLcd("SMART LOCKER", "Pintu Terkunci");
  phase("Sistem direset. Sensor siap.");
  resetBar(); renderLog(); render();
}

function clearLog() {
  if (accessLogs.length === 0) return;
  if (confirm("Hapus seluruh riwayat aktivitas? Statistik akses tidak ikut dihapus; gunakan Reset Sistem untuk itu.")) {
    accessLogs = [];
    renderLog();
  }
}

/* ===== INISIALISASI ===== */
updateDropdownUsers();

$("btnStart").addEventListener("click", () => {
  $("simulasi").scrollIntoView({ behavior: "smooth" });
  $("btnScan").focus({ preventScroll: true });
});
$("btnScan").addEventListener("click", startScan);
$("btnEnroll").addEventListener("click", startEnrollment); // Event listener untuk tombol pendaftaran sidik jari baru
$("btnReset").addEventListener("click", resetSystem);
$("btnClear").addEventListener("click", clearLog);
$("btnManual").addEventListener("click", () => (liveMode ? sendSerial("LOCK") : closeDoor()));
$("btnConnect").addEventListener("click", () => (liveMode ? disconnectArduino() : connectArduino()));
if ("serial" in navigator) navigator.serial.addEventListener("disconnect", () => { if (liveMode) disconnectArduino(true); });
$("chkErr").addEventListener("change", toggleError);
$("chkAuto").addEventListener("change", (e) => { autoLockEnabled = e.target.checked; render(); });
document.querySelectorAll("input[name=scn]").forEach((r) => r.addEventListener("change", render));

setLcd("SMART LOCKER", "Tempelkan Jari");
renderLog();
render();

/* ===== MODE LIVE: MONITORING ARDUINO LEWAT WEB SERIAL ===== */
async function connectArduino() {
  if (!("serial" in navigator)) { alert("Browser ini tidak mendukung Web Serial. Gunakan Chrome atau Edge di komputer."); return; }
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 9600 });
  } catch (e) {
    port = null;
    if (e.name !== "NotFoundError") alert("Gagal membuka port: " + e.message + "\nTutup Serial Monitor Arduino IDE lalu coba lagi.");
    return;
  }
  resetSystem();
  liveMode = true; ARDUINO_STATUS = "Online";
  $("serialLog").textContent = "";
  phase("Terhubung. Menunggu data dari Arduino.");
  render();
  readLoop();
}

async function readLoop() {
  const dec = new TextDecoderStream();
  closedPromise = port.readable.pipeTo(dec.writable).catch(() => {});
  reader = dec.readable.getReader();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { handleLine(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
    }
  } catch (e) {}
  try { reader.releaseLock(); } catch (e) {}
}

async function disconnectArduino(unplugged) {
  const p = port;
  liveMode = false; port = null;
  try { if (reader) await reader.cancel(); } catch (e) {}
  try { if (closedPromise) await closedPromise; } catch (e) {}
  try { if (p) await p.close(); } catch (e) {}
  reader = null; closedPromise = null;
  resetSystem();
  ARDUINO_STATUS = "Simulated";
  if (unplugged === true) alert("Koneksi ke Arduino terputus. Halaman kembali ke mode simulasi.");
  render();
}

async function sendSerial(text) {
  if (!port || !port.writable) return;
  const w = port.writable.getWriter();
  try { await w.write(new TextEncoder().encode(text + "\n")); } finally { w.releaseLock(); }
}

function logSerial(line) {
  const el = $("serialLog");
  const lines = (el.textContent + line + "\n").split("\n");
  el.textContent = lines.slice(-41).join("\n");
  el.scrollTop = el.scrollHeight;
}

function handleLine(l) {
  if (!l) return;
  logSerial(l);
  if (l === "Fingerprint terhubung!") {
    systemStatus = "Standby"; sensorStatus = "Ready"; setLcd("SMART LOCKER", "Tempelkan Jari");
    phase("Sensor fingerprint terhubung. Tempelkan jari pada sensor di perangkat.");
  } else if (l === "Fingerprint tidak terdeteksi!") {
    systemStatus = "Error"; sensorStatus = "Failed"; setLcd("Sensor Error", "Cek Kabel");
    phase("Sensor tidak terdeteksi. Periksa kabel.");
  } else if (l === "Membaca sidik jari...") {
    liveScanStart = performance.now(); systemStatus = "Scanning"; sensorStatus = "Scanning";
    setLcd("Membaca Jari...", ""); phase("Arduino sedang membaca sidik jari...");
  } else if (l.startsWith("ID Pemilik:")) {
    pendingId = Number(l.split(":")[1]);
  } else if (l === "LOKER TERBUKA") {
    liveResult(true);
  } else if (l === "SIDIK JARI TIDAK TERDAFTAR" || l === "Pembacaan gagal") {
    liveResult(false);
  } else if (l === "LOKER TERKUNCI" || l.startsWith("CMD:LOCKED")) {
    doorStatus = "Locked"; lockStatus = true; solenoidStatus = false; ledGreen = false;
    if (systemStatus !== "Error") { systemStatus = "Standby"; sensorStatus = "Ready"; }
    setLcd("SMART LOCKER", "Pintu Terkunci"); $("dOpen").textContent = "-";
    phase("Pintu terkunci. Menunggu sidik jari.");
  }
  render();
}

function liveResult(ok) {
  scanDuration = liveScanStart ? Math.round(performance.now() - liveScanStart) : 0;
  liveScanStart = 0;
  lastAccessTime = new Date().toLocaleString("id-ID");
  hasAuth = true; accessGranted = ok; systemStatus = "Standby";
  if (ok) {
    fingerprintID = pendingId;
    userName = pendingId === null ? "Perintah admin (serial)" : (USERS[pendingId] || ("Pemilik ID " + pendingId));
    pendingId = null;
    sensorStatus = "Success"; successfulAccess++;
    ledGreen = true; ledRed = false; lockStatus = false; solenoidStatus = true; doorStatus = "Open";
    setLcd("AKSES DITERIMA", "Loker Terbuka"); $("dOpen").textContent = "Sampai dikunci";
    phase("Sidik jari cocok. Loker terbuka.");
    addLog("Granted", "Open / Unlocked");
  } else {
    fingerprintID = null; userName = "-"; pendingId = null;
    sensorStatus = "Failed"; failedAccess++; ledGreen = false; ledRed = true;
    setLcd("AKSES DITOLAK", "Jari Tidak Cocok");
    phase("Sidik jari ditolak. Loker tetap terkunci.");
    addLog("Denied", "Locked / Locked");
    later(() => {
      ledRed = false; if (systemStatus !== "Error") sensorStatus = "Ready";
      setLcd("SMART LOCKER", "Tempelkan Jari"); render();
    }, 1200);
  }
}