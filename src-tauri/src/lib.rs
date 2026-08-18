// geo-logo デスクトップ版。
//
// フロントエンドは Web 版とまったく同じものを使い、AI 呼び出しと素材取得は
// 同梱した Hono サーバー（sidecar）が担う。ブラウザの静的モードでは CORS と
// CSP に阻まれる外部取得が、ここでは自由にできる。
//
// 構成は Graphium から移植した。踏み抜いた罠もそのまま引き継いでいる。

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;

use tauri::{Emitter, Manager};

/// 起動したサイドカーの PID。二重起動を防ぐために保持する。
struct SidecarState(Mutex<Option<u32>>);

const DEFAULT_PORT: u16 = 8787;

/// PID を殺す。プラットフォーム差を吸収する。
fn kill_pid(pid: u32) {
    #[cfg(windows)]
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    #[cfg(not(windows))]
    let _ = Command::new("kill")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// サイドカー（同梱 Node + バンドル済み Hono）を起動する。
///
/// Tauri Shell プラグインの sidecar 機能ではなく Rust から直接 spawn する。
/// Shell 経由だと Windows で spawn は成功するのに stdout/stderr が一切
/// 届かず、起動失敗の原因が追えなくなるため（Graphium で確認済み）。
#[tauri::command]
fn start_sidecar(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    port: Option<u16>,
) -> Result<u32, String> {
    let port = port.unwrap_or(DEFAULT_PORT);
    let log = |line: String| {
        let _ = app.emit("sidecar-log", line);
    };

    // 前回の子プロセスが残っていたら先に始末する
    {
        let mut guard = state.0.lock().unwrap();
        if let Some(old) = guard.take() {
            log(format!("[sidecar] 既存プロセス pid={old} を終了します"));
            kill_pid(old);
        }
    }

    // fetch-node.mjs が配置した Node と、bundle-server.mjs が出力したサーバー。
    // どちらも tauri.conf.json の resources で同梱している。
    let node_name = if cfg!(windows) { "sidecar/node.exe" } else { "sidecar/node" };
    let node = app
        .path()
        .resolve(node_name, tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("{node_name} を解決できません: {e}"))?;
    let script = app
        .path()
        .resolve("sidecar/server.mjs", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("sidecar/server.mjs を解決できません: {e}"))?;

    if !node.exists() {
        return Err(format!("Node が見つかりません: {}", node.display()));
    }
    if !script.exists() {
        return Err(format!("server.mjs が見つかりません: {}", script.display()));
    }

    // 設定と鍵の置き場。OS ごとの標準の場所に置く。
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("データディレクトリを解決できません: {e}"))?;
    let _ = std::fs::create_dir_all(&data_dir);

    let workspace_dir = workspace_dir(&app)?;
    log(format!("[sidecar] workspace: {}", workspace_dir.display()));

    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .env("GEOLOGO_PORT", port.to_string())
        .env("GEOLOGO_DATA_DIR", &data_dir)
        .env("GEOLOGO_WORKSPACE_DIR", &workspace_dir)
        // macOS では API キーをログインキーチェーンへ入れる。
        .env(
            "GEOLOGO_USE_KEYCHAIN",
            if cfg!(target_os = "macos") { "1" } else { "0" },
        )
        // サイドカーはこの PID を監視し、本体が消えたら自決する。孤児化して
        // ポートを握り続けると、次回起動で新版が古いサーバーを再利用してしまう。
        .env("GEOLOGO_PARENT_PID", std::process::id().to_string())
        // /api/health で返す。フロントが自分の版と照合し、食い違えば作り直す。
        .env("GEOLOGO_APP_VERSION", app.package_info().version.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        // 子プロセスのコンソールウィンドウを出さない（CREATE_NO_WINDOW）
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd.spawn().map_err(|e| format!("起動に失敗しました: {e}"))?;
    let pid = child.id();
    log(format!("[sidecar] pid={pid} port={port} で起動しました"));

    for (stream, tag) in [
        (child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), "stdout"),
        (child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), "stderr"),
    ] {
        let Some(stream) = stream else { continue };
        let app = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let _ = app.emit("sidecar-log", format!("[{tag}] {line}"));
            }
        });
    }

    // 終了を拾ってフロントへ知らせる
    {
        let app = app.clone();
        thread::spawn(move || {
            let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
            let _ = app.emit("sidecar-closed", code);
        });
    }

    *state.0.lock().unwrap() = Some(pid);
    Ok(pid)
}

/// アプリ設定ファイル。保存先の指定だけをここに持つ（AI モデル等は従来どおり
/// サーバー側 models.json / localStorage）。Graphium の config.json と同じ役割。
#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    /// 利用者が明示した保存先。未指定なら既定値を使う
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_root: Option<String>,
}

/// 保存先の現在値と既定値。画面に「いまどこか」を出すため
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRootInfo {
    current: String,
    default_root: String,
    is_custom: bool,
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("設定ディレクトリを解決できません: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("{} を作れません: {e}", dir.display()))?;
    Ok(dir.join("config.json"))
}

fn read_config(app: &tauri::AppHandle) -> AppConfig {
    // 壊れていても既定で走る。設定ファイルのせいでアプリが起動しない、にはしない
    let Ok(path) = config_path(app) else { return AppConfig::default() };
    let Ok(text) = std::fs::read_to_string(&path) else { return AppConfig::default() };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_config(app: &tauri::AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let text = serde_json::to_string_pretty(config).map_err(|e| format!("設定の変換に失敗: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("設定を書けません: {e}"))
}

/// 既定の保存先。Graphium の ~/Documents/Graphium と同じく、利用者が Finder から
/// 見て触れる場所に置く（設定と鍵は app_data_dir のまま）。書類フォルダを
/// 解決できない環境では app_data_dir の下に落とす。
fn default_workspace_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(docs) = app.path().document_dir() {
        return Ok(docs.join("geo-logo"));
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("データディレクトリを解決できません: {e}"))?
        .join("workspace"))
}

/// 実際に使う保存先（設定 > 既定）。フォルダは作って返す。
///
/// 指定先が作れないとき（外付けが外れている等）は既定へ落とす。履歴の置き場の
/// せいでサイドカーが起動しない、にはしない——起動さえすれば画面から
/// 保存先を選び直せる。
fn workspace_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(custom) = read_config(app).workspace_root.filter(|p| !p.trim().is_empty()) {
        let dir = PathBuf::from(custom.trim());
        if std::fs::create_dir_all(&dir).is_ok() {
            return Ok(dir);
        }
    }
    let dir = default_workspace_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("{} を作れません: {e}", dir.display()))?;
    Ok(dir)
}

/// 保存先の現在値・既定値・独自指定かどうか
#[tauri::command]
fn get_workspace_root(app: tauri::AppHandle) -> Result<WorkspaceRootInfo, String> {
    let default_root = default_workspace_dir(&app)?;
    let configured = read_config(&app).workspace_root.filter(|p| !p.trim().is_empty());
    let is_custom = configured.is_some();
    let current = configured.map(PathBuf::from).unwrap_or_else(|| default_root.clone());
    Ok(WorkspaceRootInfo {
        current: current.to_string_lossy().to_string(),
        default_root: default_root.to_string_lossy().to_string(),
        is_custom,
    })
}

/// 保存先を決める。None / 空文字は「既定に戻す」。
///
/// 指定先は**ここで作ってみる**。書けない場所を保存してしまうと、次の起動で
/// 黙って既定に落ち、「変えたのに反映されない」に見えるため。
#[tauri::command]
fn set_workspace_root(app: tauri::AppHandle, path: Option<String>) -> Result<WorkspaceRootInfo, String> {
    let mut config = read_config(&app);
    match path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
        Some(p) => {
            std::fs::create_dir_all(&p).map_err(|e| format!("{p} を使えません: {e}"))?;
            config.workspace_root = Some(p);
        }
        None => config.workspace_root = None,
    }
    write_config(&app, &config)?;
    get_workspace_root(app)
}

/// フォルダ選択ダイアログ。選ばれなければ None
#[tauri::command]
async fn pick_workspace_root(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    // blocking_* は非同期コマンド（＝別スレッド）から呼ぶ。メインスレッドで
    // 呼ぶと macOS で固まる
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked.map(|p| p.to_string()))
}

/// 履歴フォルダを OS のファイルマネージャで開く。パスは Rust 側で決めるので、
/// 画面から任意のパスを開かせる口にはならない。
#[tauri::command]
fn open_workspace_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = workspace_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("フォルダを開けません: {e}"))
}

#[tauri::command]
fn stop_sidecar(state: tauri::State<'_, SidecarState>) -> Result<(), String> {
    if let Some(pid) = state.0.lock().unwrap().take() {
        kill_pid(pid);
    }
    Ok(())
}

pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState(Mutex::new(None)));

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            start_sidecar,
            stop_sidecar,
            open_workspace_dir,
            get_workspace_root,
            set_workspace_root,
            pick_workspace_root
        ])
        .run(tauri::generate_context!())
        .expect("geo-logo の起動に失敗しました");
}
