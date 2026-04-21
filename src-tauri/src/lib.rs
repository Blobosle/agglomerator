use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{ActivationPolicy, Manager, RunEvent, State, WindowEvent};

const EXTENSION_SERVER_ADDR: &str = "127.0.0.1:39287";
const STORAGE_FILE_NAME: &str = "websites.json";
const WINDOW_PREFERENCES_FILE_NAME: &str = "window-preferences.json";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebsiteRecord {
    name: String,
    url: String,
    added_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddWebsiteRequest {
    name: String,
    url: String,
    added_at: Option<u64>,
}

struct StorageState {
    path: PathBuf,
    lock: Arc<Mutex<()>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowPreferences {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
}

struct WindowPreferencesState {
    path: PathBuf,
    lock: Arc<Mutex<()>>,
}

#[tauri::command]
fn list_websites(state: State<'_, StorageState>) -> Result<Vec<WebsiteRecord>, String> {
    read_websites(&state.path, &state.lock)
}

#[tauri::command]
fn add_website(
    name: String,
    url: String,
    state: State<'_, StorageState>,
) -> Result<Vec<WebsiteRecord>, String> {
    add_website_record(
        &state.path,
        &state.lock,
        WebsiteRecord {
            name,
            url,
            added_at: current_timestamp_millis(),
        },
    )
}

#[tauri::command]
fn delete_website(
    url: String,
    added_at: u64,
    state: State<'_, StorageState>,
) -> Result<Vec<WebsiteRecord>, String> {
    delete_website_record(&state.path, &state.lock, &url, added_at)
}

fn initialize_storage(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let app_data_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&app_data_dir)?;

    let storage_path = app_data_dir.join(STORAGE_FILE_NAME);

    if !storage_path.exists() {
        let default_websites = vec![
            WebsiteRecord {
                name: "OpenAI".into(),
                url: "https://openai.com".into(),
                added_at: 1_776_733_200_000,
            },
            WebsiteRecord {
                name: "Tauri".into(),
                url: "https://tauri.app".into(),
                added_at: 1_776_732_300_000,
            },
            WebsiteRecord {
                name: "React".into(),
                url: "https://react.dev".into(),
                added_at: 1_776_731_400_000,
            },
            WebsiteRecord {
                name: "Vite".into(),
                url: "https://vite.dev".into(),
                added_at: 1_776_730_500_000,
            },
        ];

        write_websites_file(&storage_path, &default_websites)?;
    }

    Ok(storage_path)
}

fn initialize_window_preferences(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let app_data_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&app_data_dir)?;

    Ok(app_data_dir.join(WINDOW_PREFERENCES_FILE_NAME))
}

fn restore_window_preferences(app: &tauri::App, path: &PathBuf) {
    let Ok(file_contents) = fs::read_to_string(path) else {
        return;
    };
    let Ok(preferences) = serde_json::from_str::<WindowPreferences>(&file_contents) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
        preferences.width,
        preferences.height,
    )));
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        preferences.x,
        preferences.y,
    )));
}

fn save_window_preferences(window: &tauri::Window) {
    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let preferences = WindowPreferences {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
    };
    let preferences_state = window.state::<WindowPreferencesState>();
    let Ok(_guard) = preferences_state.lock.lock() else {
        return;
    };

    if let Ok(file_contents) = serde_json::to_string_pretty(&preferences) {
        let _ = fs::write(&preferences_state.path, format!("{file_contents}\n"));
    }
}

fn read_websites(path: &PathBuf, lock: &Arc<Mutex<()>>) -> Result<Vec<WebsiteRecord>, String> {
    let _guard = lock
        .lock()
        .map_err(|_| "Storage lock is unavailable".to_string())?;
    read_websites_file(path)
}

fn read_websites_file(path: &PathBuf) -> Result<Vec<WebsiteRecord>, String> {
    let file_contents =
        fs::read_to_string(path).map_err(|error| format!("Unable to read websites: {error}"))?;

    serde_json::from_str(&file_contents)
        .map_err(|error| format!("Unable to parse websites JSON: {error}"))
}

fn add_website_record(
    path: &PathBuf,
    lock: &Arc<Mutex<()>>,
    record: WebsiteRecord,
) -> Result<Vec<WebsiteRecord>, String> {
    let _guard = lock
        .lock()
        .map_err(|_| "Storage lock is unavailable".to_string())?;
    let mut websites = read_websites_file(path)?;

    websites.push(record);
    websites.sort_by(|first, second| second.added_at.cmp(&first.added_at));
    write_websites_file(path, &websites)
        .map_err(|error| format!("Unable to write websites JSON: {error}"))?;

    Ok(websites)
}

fn delete_website_record(
    path: &PathBuf,
    lock: &Arc<Mutex<()>>,
    url: &str,
    added_at: u64,
) -> Result<Vec<WebsiteRecord>, String> {
    let _guard = lock
        .lock()
        .map_err(|_| "Storage lock is unavailable".to_string())?;
    let mut websites = read_websites_file(path)?;

    websites.retain(|website| !(website.url == url && website.added_at == added_at));
    websites.sort_by(|first, second| second.added_at.cmp(&first.added_at));
    write_websites_file(path, &websites)
        .map_err(|error| format!("Unable to write websites JSON: {error}"))?;

    Ok(websites)
}

fn write_websites_file(
    path: &PathBuf,
    websites: &[WebsiteRecord],
) -> Result<(), Box<dyn std::error::Error>> {
    let file_contents = serde_json::to_string_pretty(websites)?;

    fs::write(path, format!("{file_contents}\n"))?;

    Ok(())
}

fn current_timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn start_extension_server(path: PathBuf, lock: Arc<Mutex<()>>) {
    thread::spawn(move || {
        let listener = match TcpListener::bind(EXTENSION_SERVER_ADDR) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("Unable to start extension bridge: {error}");
                return;
            }
        };

        for stream in listener.incoming().flatten() {
            handle_extension_request(stream, &path, &lock);
        }
    });
}

fn handle_extension_request(mut stream: TcpStream, path: &PathBuf, lock: &Arc<Mutex<()>>) {
    let mut buffer = [0; 8192];
    let bytes_read = match stream.read(&mut buffer) {
        Ok(bytes_read) => bytes_read,
        Err(error) => {
            eprintln!("Unable to read extension request: {error}");
            return;
        }
    };

    let request = String::from_utf8_lossy(&buffer[..bytes_read]);

    if request.starts_with("OPTIONS ") {
        write_http_response(&mut stream, 204, "");
        return;
    }

    if !request.starts_with("POST /websites ") {
        write_http_response(&mut stream, 404, "{\"error\":\"Not found\"}");
        return;
    }

    let Some((_, body)) = request.split_once("\r\n\r\n") else {
        write_http_response(&mut stream, 400, "{\"error\":\"Missing request body\"}");
        return;
    };

    let request_body = match serde_json::from_str::<AddWebsiteRequest>(body.trim()) {
        Ok(request_body) => request_body,
        Err(_) => {
            write_http_response(&mut stream, 400, "{\"error\":\"Invalid JSON\"}");
            return;
        }
    };

    if request_body.name.trim().is_empty() || request_body.url.trim().is_empty() {
        write_http_response(&mut stream, 400, "{\"error\":\"Name and URL are required\"}");
        return;
    }

    let record = WebsiteRecord {
        name: request_body.name.trim().to_string(),
        url: request_body.url.trim().to_string(),
        added_at: request_body
            .added_at
            .unwrap_or_else(current_timestamp_millis),
    };

    match add_website_record(path, lock, record) {
        Ok(websites) => {
            let response_body = serde_json::to_string(&websites).unwrap_or_else(|_| "[]".into());
            write_http_response(&mut stream, 200, &response_body);
        }
        Err(error) => {
            let response_body = format!("{{\"error\":\"{error}\"}}");
            write_http_response(&mut stream, 500, &response_body);
        }
    }
}

fn write_http_response(stream: &mut TcpStream, status_code: u16, body: &str) {
    let status_text = match status_code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let response = format!(
        "HTTP/1.1 {status_code} {status_text}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: content-type\r\n\
         Access-Control-Allow-Methods: POST, OPTIONS\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n{}",
        body.len(),
        body,
    );

    let _ = stream.write_all(response.as_bytes());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.set_dock_visibility(true);
            app.set_activation_policy(ActivationPolicy::Regular);

            let storage_path = initialize_storage(app)?;
            let storage_lock = Arc::new(Mutex::new(()));
            let window_preferences_path = initialize_window_preferences(app)?;
            let window_preferences_lock = Arc::new(Mutex::new(()));

            app.manage(StorageState {
                path: storage_path.clone(),
                lock: Arc::clone(&storage_lock),
            });
            app.manage(WindowPreferencesState {
                path: window_preferences_path.clone(),
                lock: Arc::clone(&window_preferences_lock),
            });

            restore_window_preferences(app, &window_preferences_path);
            start_extension_server(storage_path, storage_lock);

            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                save_window_preferences(window);
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                save_window_preferences(window);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            list_websites,
            add_website,
            delete_website
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = event
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
}
