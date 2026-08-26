// Portal Windows GUI (Tauri v2). Binary kenarı — tüm domain mantığı portal-core'da;
// burası yalnız komut köprüsü + pencere. Bkz. docs/ARCHITECTURE.md §3.1.
// Release'te konsol penceresi gizlensin:
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod session;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Mutex;

use portal_core::uptime_log::{now_unix, CheckResult, DayStat, MonitorState, UptimeLog};
use portal_core::{
    AuthChoice, Config, ConnectParams, Folder, Host, HostId, Monitor, MonitorId, MonitorTarget,
    Paths, ProfileId, PtySize, Snippet, SnippetId, Store, Theme, UptimeEvent, UptimeService,
};
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

use session::{GuiCmd, Registry, SessionHandle};

/// Uygulama durumu: aktif profilin Store'u + SSH runtime + açık oturum registry'si +
/// bağlanma-anı kimlik önbelleği (ASLA diske yazılmaz). Async/tokio portal-core içinde.
struct AppState {
    store: Mutex<Store>,
    runtime: portal_core::SshRuntime,
    registry: Mutex<Registry>,
    /// Host başına bağlanma-anı kimliği (bellek içi; kalıcı DEĞİL). Shell/Files/Monitor
    /// aynı host'a tekrar bağlanınca yeniden sormasın diye.
    cached_creds: Mutex<HashMap<HostId, AuthChoice>>,
    known_hosts: PathBuf,
    /// Arka planda dönen uptime izleyici (vault kilitliyse boş listeyle döner).
    /// Mutex: içindeki olay kanalı `Sync` değil, Tauri state'i ise paylaşılıyor.
    uptime: Mutex<UptimeService>,
    /// Kontrol geçmişi (sır değil; `<data>/uptime.json`).
    uptime_log: Mutex<UptimeLog>,
    uptime_file: PathBuf,
}

impl AppState {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Store>, String> {
        self.store
            .lock()
            .map_err(|_| "internal state lock poisoned".to_string())
    }

    /// Host + kimlikten bir Endpoint çözer. `auth` verilirse önbelleğe alınır; yoksa
    /// önbellekten alınır; ikisi de yoksa hata (frontend kimlik ister).
    fn resolve_endpoint(
        &self,
        host_id: HostId,
        auth: Option<AuthInput>,
    ) -> Result<(portal_core::Endpoint, Host), String> {
        let host = {
            let store = self.lock()?;
            store
                .host(host_id)
                .ok_or("That server no longer exists.")?
                .clone()
        };
        // Kimlik üç yerden gelebilir, bu sırayla:
        //   1. kullanıcının şimdi girdiği (varsa "Remember" ile vault'a da yazılır)
        //   2. bellek önbelleği (aynı oturum içinde tekrar sormamak için)
        //   3. şifreli vault (kullanıcı daha önce "Remember" dediyse)
        // Üçü de yoksa çağıran kimlik ister.
        let choice = match auth {
            Some(a) => {
                let remember = a.remember;
                let ac = to_auth(a)?;
                self.cached_creds
                    .lock()
                    .map_err(|_| "cred cache poisoned".to_string())?
                    .insert(host_id, ac.clone());
                if remember {
                    let (key_path, secret) = match &ac {
                        AuthChoice::Password(p) => (None, p.to_string()),
                        AuthChoice::KeyFile { path, passphrase } => {
                            (Some(path.clone()), passphrase.clone().unwrap_or_default())
                        }
                    };
                    self.lock()?
                        .set_host_secret(host_id, key_path, secret)
                        .map_err(|e| e.to_string())?;
                }
                ac
            }
            None => {
                let cached = self
                    .cached_creds
                    .lock()
                    .map_err(|_| "cred cache poisoned".to_string())?
                    .get(&host_id)
                    .cloned();
                match cached {
                    Some(ac) => ac,
                    None => {
                        let stored = self.lock()?.host_secret(host_id).cloned();
                        let ac = stored
                            .map(|s| match s.key_path.clone() {
                                Some(path) => AuthChoice::KeyFile {
                                    path,
                                    passphrase: Some(s.secret.clone()).filter(|p| !p.is_empty()),
                                },
                                None => AuthChoice::Password(s.secret.clone()),
                            })
                            .ok_or("Enter credentials to connect.")?;
                        // Vault'tan geldiyse belleğe de al: aynı oturumda tekrar
                        // vault'a inmeyelim.
                        self.cached_creds
                            .lock()
                            .map_err(|_| "cred cache poisoned".to_string())?
                            .insert(host_id, ac.clone());
                        ac
                    }
                }
            }
        };
        let endpoint = session::endpoint_for(&host, choice, self.known_hosts.clone());
        Ok((endpoint, host))
    }

    /// Yeni bir oturum kaydı açar; (id, komut alıcısı) döner. Alıcı poll thread'ine geçer.
    fn register(
        &self,
        host_id: HostId,
        kind: &'static str,
    ) -> Result<(u64, mpsc::Receiver<GuiCmd>), String> {
        let mut reg = self
            .registry
            .lock()
            .map_err(|_| "registry poisoned".to_string())?;
        let id = reg.next_id;
        reg.next_id += 1;
        let (tx, rx) = mpsc::channel();
        reg.sessions.insert(
            id,
            SessionHandle {
                cmd_tx: tx,
                kind,
                host_id,
            },
        );
        Ok((id, rx))
    }

    /// Açık bir oturuma komut yollar (oturum yoksa sessizce yutar).
    fn send_cmd(&self, id: u64, cmd: GuiCmd) -> Result<(), String> {
        let reg = self
            .registry
            .lock()
            .map_err(|_| "registry poisoned".to_string())?;
        if let Some(h) = reg.sessions.get(&id) {
            let _ = h.cmd_tx.send(cmd);
        }
        Ok(())
    }

    /// Tüm açık oturumları kapatır ve registry'yi temizler (profil değişimi/kilitleme:
    /// eski profilin host'larına açık bağlantılar sarkmasın).
    fn close_all_sessions(&self) -> Result<(), String> {
        let mut reg = self
            .registry
            .lock()
            .map_err(|_| "registry poisoned".to_string())?;
        for (_, h) in reg.sessions.drain() {
            let _ = h.cmd_tx.send(GuiCmd::Close);
        }
        Ok(())
    }

    /// Store'u diskten yeniden yükler (aktif profil değişince/kilitleyince). Parolasız
    /// (keyring) profil sessizce açılır; parolalı profil kilitli başlar. Bağlanma-anı
    /// kimlik önbelleği ve açık oturumlar temizlenir (yeni profil ≠ eski host'lar).
    fn reload_store(&self) -> Result<(), String> {
        self.close_all_sessions()?;
        self.cached_creds
            .lock()
            .map_err(|_| "cred cache poisoned".to_string())?
            .clear();
        let fresh = Store::load().map_err(|e| e.to_string())?;
        let monitors = fresh.monitors().to_vec();
        *self.lock()? = fresh;
        self.reload_uptime(monitors);
        Ok(())
    }

    /// Monitör listesi değişince izleyiciyi tazeler (tek yer, her CRUD'dan sonra).
    fn resync_monitors(&self) -> Result<(), String> {
        let monitors = self.lock()?.monitors().to_vec();
        self.reload_uptime(monitors);
        Ok(())
    }

    /// İzleyiciye yeni listeyi verir (kilit zehirlendiyse sessizce geçer —
    /// uptime izlemesi uygulamayı düşürmeye değmez).
    fn reload_uptime(&self, monitors: Vec<Monitor>) {
        if let Ok(service) = self.uptime.lock() {
            service.reload(monitors);
        }
    }
}

/// Frontend'in bağlanırken gönderdiği kimlik (sır asla diske yazılmaz).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthInput {
    kind: String,
    password: Option<String>,
    path: Option<String>,
    passphrase: Option<String>,
    /// Kullanıcı "Remember" dedi mi → sır ŞİFRELİ VAULT'a yazılır (yalnız o zaman).
    #[serde(default)]
    remember: bool,
}

fn to_auth(a: AuthInput) -> Result<AuthChoice, String> {
    match a.kind.as_str() {
        "password" => Ok(AuthChoice::Password(a.password.unwrap_or_default())),
        "key" => {
            let p = a
                .path
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or("Enter the path to your key file.")?;
            Ok(AuthChoice::KeyFile {
                path: PathBuf::from(p),
                passphrase: a.passphrase.filter(|s| !s.is_empty()),
            })
        }
        _ => Err("Choose password or key-file authentication.".to_string()),
    }
}

/// Frontend açılışında gereken her şey (tek çağrı).
#[derive(Serialize)]
struct Bootstrap {
    theme: String,
    onboarded: bool,
    locked: bool,
    profile: Option<String>,
    /// Aktif profilde bir kurtarma cümlesi tanımlı mı (kilit ekranı "recovery ile aç"
    /// yolunu göstersin mi diye).
    has_recovery: bool,
    device_label: String,
    /// Pencere kapatılınca tepsiye insin mi (Settings ▸ Appearance ▸ Window).
    minimize_to_tray: bool,
    /// Vault ŞİFRELİ mi → "Remember" sunulabilir mi. Profilsiz modda vault düz
    /// metin JSON'dır ve sır oraya yazılmaz (core reddeder).
    can_remember: bool,
    /// Terminal yazı boyutu (px) — uygulama geneli, Ctrl +/- ile değişir.
    terminal_font_size: u8,
    hosts: Vec<Host>,
    folders: Vec<Folder>,
}

/// Store'un anlık durumundan bir Bootstrap kurar. Kilitliyken vault boş görünür
/// (host/folder sızdırmaz) — `is_locked` frontend'e kilit ekranı gösterir.
fn bootstrap_of(s: &Store) -> Bootstrap {
    Bootstrap {
        theme: theme_str(s.config().theme),
        onboarded: s.is_onboarded(),
        locked: s.is_locked(),
        profile: s.active_profile_name().map(str::to_string),
        has_recovery: s.active_profile_has_recovery(),
        device_label: s.device_label().to_string(),
        minimize_to_tray: s.minimize_to_tray(),
        can_remember: s.vault_is_encrypted(),
        terminal_font_size: s.terminal_font_size(),
        hosts: s.hosts().to_vec(),
        folders: s.folders().to_vec(),
    }
}

fn theme_str(t: Theme) -> String {
    match t {
        Theme::Black => "black",
        Theme::Graphite => "graphite",
        Theme::Paper => "paper",
        Theme::Contrast => "contrast",
    }
    .to_string()
}

fn theme_from(s: &str) -> Theme {
    match s {
        "graphite" => Theme::Graphite,
        "paper" => Theme::Paper,
        "contrast" => Theme::Contrast,
        _ => Theme::Black,
    }
}

/// Açılış verisi.
#[tauri::command]
fn get_bootstrap(state: State<'_, AppState>) -> Result<Bootstrap, String> {
    let s = state.lock()?;
    Ok(bootstrap_of(&s))
}

/// Host listesi (olay sonrası tazeleme için).
#[tauri::command]
fn list_hosts(state: State<'_, AppState>) -> Result<Vec<Host>, String> {
    Ok(state.lock()?.hosts().to_vec())
}

/// Klasör listesi.
#[tauri::command]
fn list_folders(state: State<'_, AppState>) -> Result<Vec<Folder>, String> {
    Ok(state.lock()?.folders().to_vec())
}

/// Bir host'un çalıştırılabilir kayıtlı komutları (Gateway "saved commands"):
/// global + o host'a özel.
#[tauri::command]
fn host_snippets(state: State<'_, AppState>, host_id: HostId) -> Result<Vec<Snippet>, String> {
    Ok(state
        .lock()?
        .snippets_for_host(host_id)
        .into_iter()
        .cloned()
        .collect())
}

/// Tüm kayıtlı komutlar (Snippets yöneticisi): global + tüm host'lara özel.
#[tauri::command]
fn list_snippets(state: State<'_, AppState>) -> Result<Vec<Snippet>, String> {
    Ok(state.lock()?.snippets().to_vec())
}

/// Label boşsa komutu etiket yap (host adı gibi opsiyonel ad davranışı).
fn snippet_label(label: &str, command: &str) -> String {
    let label = label.trim();
    if label.is_empty() {
        command.trim().to_string()
    } else {
        label.to_string()
    }
}

/// Yeni kayıtlı komut ekler; diske yazar; "snippets-changed" yayınlar.
#[tauri::command]
fn add_snippet(
    app: AppHandle,
    state: State<'_, AppState>,
    label: String,
    command: String,
    host_id: Option<HostId>,
) -> Result<Snippet, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("Enter the command to run.".to_string());
    }
    let mut snippet = Snippet::new(snippet_label(&label, &command), command);
    snippet.host_id = host_id;
    let created = snippet.clone();
    state
        .lock()?
        .add_snippet(snippet)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("portal://snippets-changed", ());
    Ok(created)
}

/// Var olan kayıtlı komutu (kimliğine göre) günceller; diske yazar; olay yayınlar.
#[tauri::command]
fn update_snippet(
    app: AppHandle,
    state: State<'_, AppState>,
    id: SnippetId,
    label: String,
    command: String,
    host_id: Option<HostId>,
) -> Result<Snippet, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("Enter the command to run.".to_string());
    }
    let snippet = Snippet {
        id,
        label: snippet_label(&label, &command),
        command,
        host_id,
    };
    let updated = snippet.clone();
    state
        .lock()?
        .update_snippet(snippet)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("portal://snippets-changed", ());
    Ok(updated)
}

/// Kayıtlı komutu siler; "snippets-changed" yayınlar.
#[tauri::command]
fn remove_snippet(app: AppHandle, state: State<'_, AppState>, id: SnippetId) -> Result<(), String> {
    state
        .lock()?
        .remove_snippet(id)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("portal://snippets-changed", ());
    Ok(())
}

/// Açık bir oturum kaydı (frontend: açık terminal/dosya/izleme sayımı & listesi).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    id: u64,
    kind: String,
    host_id: HostId,
}

/// Şu an açık tüm oturumlar (id + tür + host).
#[tauri::command]
fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionInfo>, String> {
    let reg = state
        .registry
        .lock()
        .map_err(|_| "registry poisoned".to_string())?;
    Ok(reg
        .sessions
        .iter()
        .map(|(id, h)| SessionInfo {
            id: *id,
            kind: h.kind.to_string(),
            host_id: h.host_id,
        })
        .collect())
}

/// Bir host'un bağlanma-anı kimliğini önbellekten siler (kimlik reddedilince →
/// sonraki denemede yeniden sorulsun).
#[tauri::command]
fn forget_creds(state: State<'_, AppState>, host_id: HostId) -> Result<(), String> {
    state
        .cached_creds
        .lock()
        .map_err(|_| "cred cache poisoned".to_string())?
        .remove(&host_id);
    // Saklanmış sır da gitsin: "unut" dediğinde vault'ta kalırsa bir sonraki
    // bağlanmada yine sessizce kullanılır ve kullanıcı unuttuğunu sanır.
    state
        .lock()?
        .clear_host_secret(host_id)
        .map_err(|e| e.to_string())
}

/// Bu host için bağlanma-anı kimliği önbellekte var mı (Gateway: Connect doğrudan mı,
/// yoksa önce kimlik iste mi).
#[tauri::command]
fn host_is_cached(state: State<'_, AppState>, host_id: HostId) -> bool {
    let in_memory = state
        .cached_creds
        .lock()
        .map(|m| m.contains_key(&host_id))
        .unwrap_or(false);
    // Vault'ta saklanmış sır da "kimlik hazır" demektir — Gateway doğrudan bağlanır,
    // uygulama yeniden açılsa bile parola sormaz.
    in_memory || state.lock().is_ok_and(|s| s.host_secret(host_id).is_some())
}

/// Yeni host ekler, diske yazar; "hosts-changed" olayı yayınlar (köprü demosu).
#[tauri::command]
fn add_host(
    app: AppHandle,
    state: State<'_, AppState>,
    label: String,
    address: String,
    port: Option<u16>,
    username: Option<String>,
) -> Result<Host, String> {
    let label = label.trim();
    let address = address.trim();
    // Display Name (label) opsiyonel — boşsa kartta adres/IP gösterilir. Adres zorunlu.
    if address.is_empty() {
        return Err("Enter the server's address.".to_string());
    }
    let mut host = Host::new(label, address);
    if let Some(p) = port {
        host.port = p;
    }
    host.username = username
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());
    let created = host.clone();
    state.lock()?.add_host(host).map_err(|e| e.to_string())?;
    let _ = app.emit("portal://hosts-changed", ());
    Ok(created)
}

/// Var olan host'u günceller: Display Name (label, boş olabilir) / Login Username /
/// adres / port. Diske yazar ve "hosts-changed" yayınlar.
#[tauri::command]
fn update_host(
    app: AppHandle,
    state: State<'_, AppState>,
    id: HostId,
    label: String,
    address: String,
    port: Option<u16>,
    username: Option<String>,
) -> Result<Host, String> {
    let label = label.trim();
    let address = address.trim();
    if address.is_empty() {
        return Err("Enter the server's address.".to_string());
    }
    let updated = {
        let mut s = state.lock()?;
        let mut host = s.host(id).ok_or("That server no longer exists.")?.clone();
        host.label = label.to_string();
        host.address = address.to_string();
        host.port = port.unwrap_or(portal_core::DEFAULT_SSH_PORT);
        host.username = username
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty());
        s.update_host(host.clone()).map_err(|e| e.to_string())?;
        host
    };
    let _ = app.emit("portal://hosts-changed", ());
    Ok(updated)
}

/// Bir host'un "auto-connect" (sayfa açılınca otomatik shell) bayrağını ayarlar.
#[tauri::command]
fn set_host_auto_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    id: HostId,
    value: bool,
) -> Result<Host, String> {
    let updated = {
        let mut s = state.lock()?;
        let mut host = s.host(id).ok_or("That server no longer exists.")?.clone();
        host.auto_connect = value;
        s.update_host(host.clone()).map_err(|e| e.to_string())?;
        host
    };
    let _ = app.emit("portal://hosts-changed", ());
    Ok(updated)
}

/// Host siler; "hosts-changed" yayınlar.
#[tauri::command]
fn remove_host(app: AppHandle, state: State<'_, AppState>, id: HostId) -> Result<(), String> {
    state.lock()?.remove_host(id).map_err(|e| e.to_string())?;
    let _ = app.emit("portal://hosts-changed", ());
    Ok(())
}

/// Temayı değiştirir ve config'e yazar.
#[tauri::command]
fn set_theme(state: State<'_, AppState>, theme: String) -> Result<(), String> {
    let mut s = state.lock()?;
    let mut config: Config = s.config().clone();
    config.theme = theme_from(&theme);
    s.set_config(config).map_err(|e| e.to_string())
}

// ── Onboarding / kilit / profil (Faz 3-C) ────────────────────────────────────

/// İlk-çalıştırma sihirbazını tamamlar: temayı ayarlar, opsiyonel şifreli profil kurar,
/// `onboarded` bayrağını işaretler. Ad/parola boşsa profil atlanır (keyring varsa yine
/// sessizce şifreli "default" profil kurulur). Güncel açılış verisini döndürür.
///
/// `recovery_phrase` verilirse (parola profili için onboarding'de üretilir), profil
/// kurulduktan hemen sonra vault'a ikinci bir açma yolu olarak sarılır. Vault o an
/// açıktır (DEK biliniyor); yalnız yeni bir KEK sarımı eklenir.
#[tauri::command]
fn complete_onboarding(
    state: State<'_, AppState>,
    theme: String,
    profile_name: Option<String>,
    password: Option<String>,
    recovery_phrase: Option<String>,
) -> Result<Bootstrap, String> {
    let mut s = state.lock()?;
    let name = profile_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty());
    let pw = password.as_deref().filter(|p| !p.is_empty());
    s.complete_onboarding(theme_from(&theme), name, pw)
        .map_err(|e| e.to_string())?;
    // Parola profiline kurtarma cümlesi üretildiyse şimdi sar (vault açık).
    if let Some(phrase) = recovery_phrase
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        s.set_recovery_phrase(phrase).map_err(|e| e.to_string())?;
    }
    Ok(bootstrap_of(&s))
}

/// Yeni bir kurtarma cümlesi üretir (onboarding ekranı gösterip kullanıcıya kaydettirir).
/// Saf: durum değiştirmez. Cümle yalnız kullanıcıya gösterilmek üzere döner; kalıcılaşması
/// `complete_onboarding`'e geri verilmesiyle olur.
#[tauri::command]
fn generate_recovery_phrase() -> String {
    portal_core::generate_phrase().to_string()
}

/// Kilitli aktif profili kurtarma cümlesiyle açar (parola unutulduğunda son çare).
/// Başarılıysa güncel açılış verisini döndürür; cümle yanlışsa sır sızdırmayan hata.
#[tauri::command]
fn unlock_with_recovery(state: State<'_, AppState>, phrase: String) -> Result<Bootstrap, String> {
    // Kurtarma cümlesini kullanımdan sonra bellekten sıfırla (P6-D #2).
    let phrase = zeroize::Zeroizing::new(phrase);
    let mut s = state.lock()?;
    s.unlock_with_recovery(&phrase).map_err(|_| {
        // Sırrı ele vermeyen, yol gösteren mesaj (DESIGN §10).
        "That recovery phrase didn't unlock this profile. Check the words and try again."
            .to_string()
    })?;
    Ok(bootstrap_of(&s))
}

/// Kilitli aktif profili parolayla açar. Başarılıysa güncel (vault yüklü) açılış
/// verisini döndürür; parola yanlışsa hata (frontend "wrong password" gösterir).
#[tauri::command]
fn unlock_vault(state: State<'_, AppState>, password: String) -> Result<Bootstrap, String> {
    // Parolayı kullanımdan sonra bellekten sıfırla (P6-D #2).
    let password = zeroize::Zeroizing::new(password);
    let mut s = state.lock()?;
    s.unlock(&password).map_err(|_| {
        // Sırrı ele vermeyen, yol gösteren mesaj (DESIGN §10).
        "That password didn't unlock this profile. Try again.".to_string()
    })?;
    Ok(bootstrap_of(&s))
}

/// Profil listesi öğesi (hassas olmayan indeks + aktif işareti).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileInfo {
    id: ProfileId,
    name: String,
    locked_with_password: bool,
    active: bool,
}

/// Yerel profillerin (hassas olmayan) listesi + hangisi aktif.
#[tauri::command]
fn list_profiles(state: State<'_, AppState>) -> Result<Vec<ProfileInfo>, String> {
    let s = state.lock()?;
    let active = s.active_profile();
    Ok(s.profiles()
        .iter()
        .map(|p| ProfileInfo {
            id: p.id,
            name: p.name.clone(),
            locked_with_password: p.locked_with_password,
            active: Some(p.id) == active,
        })
        .collect())
}

/// Aktif profili değiştirir: config'e yazıp store'u diskten tazeler. Hedef parolalıysa
/// yeni durum kilitli döner (frontend kilit ekranı gösterir); keyring profili sessiz açılır.
#[tauri::command]
fn switch_profile(state: State<'_, AppState>, id: ProfileId) -> Result<Bootstrap, String> {
    {
        let mut s = state.lock()?;
        if s.active_profile() == Some(id) {
            return Ok(bootstrap_of(&s));
        }
        if !s.profiles().iter().any(|p| p.id == id) {
            return Err("That profile no longer exists.".to_string());
        }
        let mut config: Config = s.config().clone();
        config.active_profile = Some(id);
        s.set_config(config).map_err(|e| e.to_string())?;
    }
    // Yeni aktif profili diskten yükle (oturumlar + kimlik önbelleği temizlenir).
    state.reload_store()?;
    let s = state.lock()?;
    Ok(bootstrap_of(&s))
}

/// Aktif profili yeniden kilitler (store'u diskten tazeler). Parolalı profil kilitli
/// döner; keyring profili makine-anahtarıyla sessizce yeniden açılır (kilitlenemez).
#[tauri::command]
fn lock_now(state: State<'_, AppState>) -> Result<Bootstrap, String> {
    state.reload_store()?;
    let s = state.lock()?;
    Ok(bootstrap_of(&s))
}

// ── BYOS senkron (Faz 3-C) ───────────────────────────────────────────────────

/// Senkron durumu (klasör + karşılaştırma). Şifre çözmeden okunur (zarf başlığından).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncInfo {
    /// Ayarlı hedef klasör (yoksa senkron kapalı).
    dir: Option<String>,
    /// Senkron öncesi durum etiketi (ör. "local is newer — will push").
    label: Option<String>,
    /// Yerel vault'un son-yazılma zamanı (unix ms) ve cihazı.
    local_updated: Option<u64>,
    local_device: Option<String>,
    /// Uzak (klasördeki) vault'un son-yazılma zamanı ve cihazı.
    remote_updated: Option<u64>,
    remote_device: Option<String>,
}

/// Senkron ayarını + durumunu döndürür.
#[tauri::command]
fn sync_get(state: State<'_, AppState>) -> Result<SyncInfo, String> {
    let s = state.lock()?;
    let dir = s.sync_dir().map(|p| p.to_string_lossy().into_owned());
    let status = s.sync_status().map_err(|e| e.to_string())?;
    let (label, local, remote) = match status {
        Some(st) => (
            Some(st.outcome.status_label().to_string()),
            st.local,
            st.remote,
        ),
        None => (None, None, None),
    };
    Ok(SyncInfo {
        dir,
        label,
        local_updated: local.as_ref().map(|h| h.updated_at),
        local_device: local.map(|h| h.device_label),
        remote_updated: remote.as_ref().map(|h| h.updated_at),
        remote_device: remote.map(|h| h.device_label),
    })
}

/// Senkron hedef klasörünü ayarlar/temizler (boş → kapatır).
#[tauri::command]
fn set_sync_dir(state: State<'_, AppState>, dir: Option<String>) -> Result<(), String> {
    let dir = dir
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .map(PathBuf::from);
    state.lock()?.set_sync_dir(dir).map_err(|e| e.to_string())
}

/// Senkron sonucu: kullanıcıya dönük mesaj + (uzaktan çekildiyse) yeni açılış verisi.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncResult {
    /// "Pushed your vault to the folder." / "Pulled a newer vault…" vb.
    message: String,
    /// Uzaktan çekildikten sonra vault kilitli mi (yabancı parolalı vault → kilit ekranı).
    locked: bool,
}

/// Yerel ile uzak vault'u uzlaştırır (son-yazan-kazanır). Kilit gerekmez — şifreli
/// baytlar kopyalanır. Uzak çekilirse bellekteki vault tazelenir (kilitlenebilir).
#[tauri::command]
fn sync_now(state: State<'_, AppState>) -> Result<SyncResult, String> {
    let mut s = state.lock()?;
    let outcome = s.sync_now().map_err(|e| e.to_string())?;
    Ok(SyncResult {
        message: outcome.describe().to_string(),
        locked: s.is_locked(),
    })
}

// ── Oturum komutları (Terminal / Files / Monitor) ────────────────────────────

/// İnteraktif shell başlatır; oturum kimliği döner. Olaylar `portal://ssh/{id}`.
#[tauri::command]
fn connect_shell(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: HostId,
    auth: Option<AuthInput>,
    cols: u16,
    rows: u16,
) -> Result<u64, String> {
    let (endpoint, _host) = state.resolve_endpoint(host_id, auth)?;
    let pty = PtySize {
        cols: cols.max(1),
        rows: rows.max(1),
    };
    let ssh = state.runtime.connect(ConnectParams { endpoint, pty });
    let (id, cmd_rx) = state.register(host_id, "shell")?;
    session::spawn_shell(app, id, ssh, cmd_rx);
    Ok(id)
}

/// SFTP oturumu başlatır; kimlik döner. Olaylar `portal://sftp/{id}`.
#[tauri::command]
fn connect_files(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: HostId,
    auth: Option<AuthInput>,
) -> Result<u64, String> {
    let (endpoint, _host) = state.resolve_endpoint(host_id, auth)?;
    let sftp = state.runtime.connect_sftp(endpoint);
    let (id, cmd_rx) = state.register(host_id, "files")?;
    session::spawn_files(app, id, sftp, cmd_rx);
    Ok(id)
}

/// İzleme oturumu başlatır; kimlik döner. Olaylar `portal://metrics/{id}`.
#[tauri::command]
fn connect_monitor(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: HostId,
    auth: Option<AuthInput>,
) -> Result<u64, String> {
    let (endpoint, _host) = state.resolve_endpoint(host_id, auth)?;
    let system = state.runtime.connect_system(endpoint);
    let (id, cmd_rx) = state.register(host_id, "monitor")?;
    session::spawn_system(app, id, system, cmd_rx);
    Ok(id)
}

/// Shell'e girdi (xterm onData string'i → baytlar).
#[tauri::command]
fn send_input(state: State<'_, AppState>, id: u64, data: String) -> Result<(), String> {
    state.send_cmd(id, GuiCmd::Input(data.into_bytes()))
}

/// PTY'yi yeniden boyutlandır.
#[tauri::command]
fn resize_pty(state: State<'_, AppState>, id: u64, cols: u16, rows: u16) -> Result<(), String> {
    state.send_cmd(id, GuiCmd::Resize { cols, rows })
}

/// Host-key kararını (kabul/ret) oturuma ilet.
#[tauri::command]
fn host_key_decision(state: State<'_, AppState>, id: u64, accept: bool) -> Result<(), String> {
    state.send_cmd(id, GuiCmd::HostKey(accept))
}

/// Bir oturumu kapatır ve registry'den kaldırır.
#[tauri::command]
fn close_session(state: State<'_, AppState>, id: u64) -> Result<(), String> {
    let handle = {
        let mut reg = state
            .registry
            .lock()
            .map_err(|_| "registry poisoned".to_string())?;
        reg.sessions.remove(&id)
    };
    if let Some(h) = handle {
        let _ = h.cmd_tx.send(GuiCmd::Close);
    }
    Ok(())
}

/// SFTP: uzak dizini listele.
#[tauri::command]
fn sftp_list(state: State<'_, AppState>, id: u64, path: String) -> Result<(), String> {
    state.send_cmd(id, GuiCmd::List(path))
}

/// SFTP: yerel dosyayı uzağa yükle.
#[tauri::command]
fn sftp_upload(
    state: State<'_, AppState>,
    id: u64,
    local: String,
    remote: String,
) -> Result<(), String> {
    state.send_cmd(
        id,
        GuiCmd::Upload {
            local: PathBuf::from(local),
            remote,
        },
    )
}

/// SFTP: uzak dosyayı yerele indir.
#[tauri::command]
fn sftp_download(
    state: State<'_, AppState>,
    id: u64,
    remote: String,
    local: String,
) -> Result<(), String> {
    state.send_cmd(
        id,
        GuiCmd::Download {
            remote,
            local: PathBuf::from(local),
        },
    )
}

/// SFTP: bir transferi iptal et.
#[tauri::command]
fn sftp_cancel(state: State<'_, AppState>, id: u64, transfer_id: u64) -> Result<(), String> {
    state.send_cmd(id, GuiCmd::Cancel(transfer_id))
}

/// SFTP: uzak dizin oluştur (başarıda üst dizin yeniden listelenir).
#[tauri::command]
fn sftp_mkdir(state: State<'_, AppState>, id: u64, path: String) -> Result<(), String> {
    state.send_cmd(id, GuiCmd::Mkdir(path))
}

/// SFTP: uzak dosya/dizini yeniden adlandır (taşı).
#[tauri::command]
fn sftp_rename(
    state: State<'_, AppState>,
    id: u64,
    from: String,
    to: String,
) -> Result<(), String> {
    state.send_cmd(id, GuiCmd::Rename { from, to })
}

/// SFTP: uzak metin dosyasını oku (gömülü editör). Yanıt `portal://sftp/{id}`
/// üzerinden `remoteContent` / `editError` olarak gelir.
#[tauri::command]
fn sftp_read(state: State<'_, AppState>, id: u64, path: String) -> Result<(), String> {
    state.send_cmd(id, GuiCmd::ReadRemote(path))
}

/// SFTP: uzak metin dosyasını yaz (gömülü editör kaydı).
#[tauri::command]
fn sftp_write(
    state: State<'_, AppState>,
    id: u64,
    path: String,
    text: String,
) -> Result<(), String> {
    state.send_cmd(
        id,
        GuiCmd::WriteRemote {
            path,
            bytes: text.into_bytes(),
        },
    )
}

/// SFTP: uzak dosyayı/dizini sil (is_dir → boş dizin siler).
#[tauri::command]
fn sftp_remove(
    state: State<'_, AppState>,
    id: u64,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let cmd = if is_dir {
        GuiCmd::RemoveDir(path)
    } else {
        GuiCmd::RemoveFile(path)
    };
    state.send_cmd(id, cmd)
}

// ── Uptime monitörü ─────────────────────────────────────────────────────────

/// Panelin bir monitör için ihtiyaç duyduğu her şey (tek çağrıda).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitorSummary {
    monitor: Monitor,
    state: MonitorState,
    /// Son kontrol (durum noktası + gecikme + hata metni).
    last: Option<CheckResult>,
    /// Bugünün özeti (uptime% ve ortalama gecikme buradan okunur).
    today: DayStat,
    /// Son 30 günün özeti (bar grafiği).
    days: Vec<DayStat>,
    /// Son kontroller, eskiden yeniye (sparkline + son olaylar).
    recent: Vec<CheckResult>,
}

/// Panelde gösterilen gün sayısı.
const SUMMARY_DAYS: usize = 30;
/// Panelde gösterilen ham kontrol sayısı.
const SUMMARY_RECENT: usize = 60;

/// Tüm monitörlerin durumu + geçmiş özeti.
#[tauri::command]
fn list_monitors(state: State<'_, AppState>) -> Result<Vec<MonitorSummary>, String> {
    let store = state.lock()?;
    let log = state
        .uptime_log
        .lock()
        .map_err(|_| "uptime log lock poisoned".to_string())?;
    let today = now_unix() / 86_400;

    Ok(store
        .monitors()
        .iter()
        .map(|monitor| {
            let history = log.history(monitor.id);
            let days = history.map(|h| h.days.as_slice()).unwrap_or_default();
            let recent = history.map(|h| h.recent.as_slice()).unwrap_or_default();
            MonitorSummary {
                monitor: monitor.clone(),
                state: history
                    .map(portal_core::MonitorHistory::state)
                    .unwrap_or_default(),
                last: recent.last().cloned(),
                today: days
                    .last()
                    .copied()
                    .filter(|d| d.day == today)
                    .unwrap_or(DayStat {
                        day: today,
                        ..DayStat::default()
                    }),
                days: days[days.len().saturating_sub(SUMMARY_DAYS)..].to_vec(),
                recent: recent[recent.len().saturating_sub(SUMMARY_RECENT)..].to_vec(),
            }
        })
        .collect())
}

/// Frontend'in gönderdiği monitör hedefi (form alanları).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MonitorInput {
    label: String,
    /// "http" veya "tcp".
    kind: String,
    /// HTTP: tam URL. TCP: host adı.
    target: String,
    /// TCP portu.
    port: Option<u16>,
    /// HTTP: beklenen durum kodu (boşsa herhangi bir 2xx/3xx).
    expect_status: Option<u16>,
    interval_secs: u32,
    timeout_secs: u32,
    enabled: bool,
    host_id: Option<HostId>,
}

/// Form girdisini domain modeline çevirir (boş/eksik alanlar için İngilizce hata).
fn to_target(input: &MonitorInput) -> Result<MonitorTarget, String> {
    let target = input.target.trim();
    if target.is_empty() {
        return Err("Enter an address to check.".to_string());
    }
    match input.kind.as_str() {
        "http" => {
            let url = if target.starts_with("http://") || target.starts_with("https://") {
                target.to_string()
            } else {
                format!("https://{target}")
            };
            Ok(MonitorTarget::Http {
                url,
                expect_status: input.expect_status,
            })
        }
        "tcp" => Ok(MonitorTarget::Tcp {
            host: target.to_string(),
            port: input.port.ok_or("Enter a port to check.")?,
        }),
        _ => Err("Choose an HTTP or TCP check.".to_string()),
    }
}

/// Girdiden monitör kurar (kimlik çağırana ait — ekleme yeni, düzenleme mevcut).
fn monitor_from(id: MonitorId, input: MonitorInput) -> Result<Monitor, String> {
    let target = to_target(&input)?;
    let label = input.label.trim();
    Ok(Monitor {
        id,
        label: if label.is_empty() {
            target.display()
        } else {
            label.to_string()
        },
        target,
        // 10 sn'nin altına inmek sunucuyu döver, faydası yok.
        interval_secs: input.interval_secs.max(10),
        timeout_secs: input.timeout_secs.clamp(1, 60),
        enabled: input.enabled,
        host_id: input.host_id,
    })
}

/// Yeni monitör ekler ve hemen ilk kontrolü tetikler.
#[tauri::command]
fn add_monitor(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MonitorInput,
) -> Result<MonitorId, String> {
    let monitor = monitor_from(MonitorId::new(), input)?;
    let id = state
        .lock()?
        .add_monitor(monitor)
        .map_err(|e| e.to_string())?;
    state.resync_monitors()?;
    let _ = app.emit("portal://monitors-changed", ());
    Ok(id)
}

/// Var olan monitörü günceller.
#[tauri::command]
fn update_monitor(
    app: AppHandle,
    state: State<'_, AppState>,
    id: MonitorId,
    input: MonitorInput,
) -> Result<(), String> {
    let monitor = monitor_from(id, input)?;
    state
        .lock()?
        .update_monitor(monitor)
        .map_err(|e| e.to_string())?;
    state.resync_monitors()?;
    let _ = app.emit("portal://monitors-changed", ());
    Ok(())
}

/// Monitörü ve geçmişini siler.
#[tauri::command]
fn remove_monitor(app: AppHandle, state: State<'_, AppState>, id: MonitorId) -> Result<(), String> {
    state
        .lock()?
        .remove_monitor(id)
        .map_err(|e| e.to_string())?;
    let keep: Vec<MonitorId> = state.lock()?.monitors().iter().map(|m| m.id).collect();
    {
        let mut log = state
            .uptime_log
            .lock()
            .map_err(|_| "uptime log lock poisoned".to_string())?;
        log.retain_only(&keep);
        let _ = log.save(&state.uptime_file);
    }
    state.resync_monitors()?;
    let _ = app.emit("portal://monitors-changed", ());
    Ok(())
}

/// Bir monitörü sırasını beklemeden kontrol eder.
#[tauri::command]
fn check_monitor_now(state: State<'_, AppState>, id: MonitorId) -> Result<(), String> {
    state
        .uptime
        .lock()
        .map_err(|_| "uptime service lock poisoned".to_string())?
        .check_now(id);
    Ok(())
}

/// Pencere kapatılınca tepsiye inme ayarını değiştirir.
#[tauri::command]
fn set_minimize_to_tray(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    state
        .lock()?
        .set_minimize_to_tray(enabled)
        .map_err(|e| e.to_string())
}

/// Terminal yazı boyutunu (px) ayarlar; sınırlara kırpılmış değeri döndürür.
/// Host başına değil, uygulama geneli (config.toml).
#[tauri::command]
fn set_terminal_font_size(state: State<'_, AppState>, px: u8) -> Result<u8, String> {
    state
        .lock()?
        .set_terminal_font_size(px)
        .map_err(|e| e.to_string())
}

/// Terminalde tıklanan bir bağlantıyı sistem tarayıcısında açar.
///
/// URL uzak sunucunun çıktısından gelir → güvenilmez. Frontend zaten kullanıcıya
/// onay sordu; burada ikinci kapı olarak şema beyaz listesi var: yalnız http/https.
/// `file:`, `javascript:` ya da özel şemalar sessizce reddedilmez, hata döner.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    checked_web_url(&url)?;
    tauri_plugin_opener::open_url(&url, None::<&str>)
        .map_err(|e| format!("Couldn't open {url} in your browser: {e}"))
}

/// Şema beyaz listesi: yalnız `http` ve `https` — şema büyük/küçük harf duyarsız,
/// gerisi değil. Ayrı fonksiyon çünkü test edilmesi gereken kısım bu; açma işini
/// OS yapar.
fn checked_web_url(url: &str) -> Result<(), String> {
    let scheme = url.split_once("://").map(|(s, _)| s.to_ascii_lowercase());
    if matches!(scheme.as_deref(), Some("http") | Some("https")) {
        return Ok(());
    }
    Err(format!(
        "Portal only opens http:// and https:// links. Got: {url}"
    ))
}

/// Pencereyi geri getirir (tepsi menüsü / tepsi ikonuna tık).
fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Sistem tepsisi ikonu + menüsü. İkon her zaman kurulur; ayar yalnız pencere
/// KAPATMA davranışını belirler (tepsi ikonu ayrıca gizli pencereye tek dönüş yolu).
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Portal", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Portal")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        // Sol tık pencereyi geri getirir (Windows'ta beklenen davranış); menü sağ tıkta.
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Yerel dizin listesi (Files "This PC" tarafı).
#[tauri::command]
fn list_local(path: String) -> Result<session::LocalListing, String> {
    session::list_local(&path)
}

/// Yerel home dizini (Files başlangıcı).
#[tauri::command]
fn local_home() -> String {
    session::local_home()
}

/// Uptime olaylarını geçmişe yazıp frontend'e duyurur.
///
/// Geçmiş her kontrolde değil, en fazla [`SAVE_EVERY`]'de bir diske yazılır:
/// dosya bütün olarak yeniden yazıldığı için her sonuçta save etmek gereksiz I/O.
fn pump_uptime(app: AppHandle) {
    /// Diske yazma sıklığı.
    const SAVE_EVERY: std::time::Duration = std::time::Duration::from_secs(15);

    let mut dirty = false;
    let mut last_save = std::time::Instant::now();
    loop {
        let state = app.state::<AppState>();
        while let Some(UptimeEvent::Checked(result)) =
            state.uptime.lock().ok().and_then(|s| s.try_event())
        {
            let monitor_id = result.monitor_id;
            let up = result.up;
            if let Ok(mut log) = state.uptime_log.lock() {
                log.record(result);
                dirty = true;
            }
            let _ = app.emit("portal://uptime", UptimeMsg { monitor_id, up });
        }

        if dirty && last_save.elapsed() >= SAVE_EVERY {
            if let Ok(log) = state.uptime_log.lock() {
                // Yazılamazsa geçmiş bellekte kalır; bir sonraki turda yine denenir.
                let _ = log.save(&state.uptime_file);
            }
            dirty = false;
            last_save = std::time::Instant::now();
        }

        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

/// Frontend'e giden kontrol bildirimi (ayrıntıyı panel `list_monitors` ile çeker).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UptimeMsg {
    monitor_id: MonitorId,
    up: bool,
}

fn main() {
    let store = Store::load().expect("Portal couldn't open its data directory");
    let runtime = portal_core::SshRuntime::new().expect("Portal couldn't start its SSH runtime");
    let paths = Paths::resolve().ok();
    let known_hosts = paths
        .as_ref()
        .map(Paths::known_hosts_file)
        .unwrap_or_else(|| PathBuf::from("known_hosts"));
    let uptime_file = paths
        .as_ref()
        .map(Paths::uptime_file)
        .unwrap_or_else(|| PathBuf::from("uptime.json"));
    let uptime_log = UptimeLog::load(&uptime_file);
    // Kilitli profilde `monitors()` boştur → izleyici boş listeyle döner, kilit
    // açılınca `reload_store` gerçek listeyi yükler.
    let uptime = UptimeService::start(store.monitors().to_vec());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            store: Mutex::new(store),
            runtime,
            registry: Mutex::new(Registry::default()),
            cached_creds: Mutex::new(HashMap::new()),
            known_hosts,
            uptime: Mutex::new(uptime),
            uptime_log: Mutex::new(uptime_log),
            uptime_file,
        })
        .invoke_handler(tauri::generate_handler![
            get_bootstrap,
            list_hosts,
            list_folders,
            host_snippets,
            list_snippets,
            add_snippet,
            update_snippet,
            remove_snippet,
            list_sessions,
            forget_creds,
            host_is_cached,
            add_host,
            update_host,
            set_host_auto_connect,
            remove_host,
            set_theme,
            complete_onboarding,
            generate_recovery_phrase,
            unlock_with_recovery,
            unlock_vault,
            list_profiles,
            switch_profile,
            lock_now,
            sync_get,
            set_sync_dir,
            sync_now,
            connect_shell,
            connect_files,
            connect_monitor,
            send_input,
            resize_pty,
            host_key_decision,
            close_session,
            sftp_list,
            sftp_upload,
            sftp_download,
            sftp_cancel,
            sftp_mkdir,
            sftp_rename,
            sftp_remove,
            sftp_read,
            sftp_write,
            list_local,
            local_home,
            list_monitors,
            add_monitor,
            update_monitor,
            remove_monitor,
            check_monitor_now,
            set_minimize_to_tray,
            set_terminal_font_size,
            open_external
        ])
        .setup(|app| {
            // Pencere gizli açılır; frontend hazır olunca JS `show()` çağırır (gri boş
            // pencere olmaz). Emniyet: içerik gelmese bile birkaç saniye sonra göster.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(6));
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.show();
                }
            });

            // Uptime kontrolleri pencereden bağımsız döner (tray'e inince de sürsün).
            let handle = app.handle().clone();
            std::thread::spawn(move || pump_uptime(handle));

            setup_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Ayar açıksa kapatma = tepsiye inme: uygulama (ve uptime kontrolleri)
            // çalışmaya devam eder. Çıkış tepsi menüsündeki "Quit" ile.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let tray = window
                    .app_handle()
                    .state::<AppState>()
                    .lock()
                    .map(|s| s.minimize_to_tray())
                    .unwrap_or(false);
                if tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Portal");
}

#[cfg(test)]
mod tests {
    use super::checked_web_url;

    #[test]
    fn only_http_and_https_links_are_opened() {
        assert!(checked_web_url("https://example.com/a?b=c").is_ok());
        assert!(checked_web_url("http://10.0.0.5:8080/").is_ok());
        assert!(checked_web_url("HTTPS://example.com").is_ok());

        // Uzak sunucu bunları çıktısına basabilir; hiçbiri OS'e gitmez.
        for bad in [
            "file:///C:/Windows/notepad.exe",
            "javascript:void(0)",
            "custom-handler:/id",
            "  https://example.com",
        ] {
            let err = checked_web_url(bad).unwrap_err();
            // Hata denenen değeri gösterir (kullanıcı neyin reddedildiğini görür).
            assert!(err.contains(bad), "got: {err}");
        }
    }
}
