const button = document.getElementById('connect');
const status = document.getElementById('status');
let busy = false;
async function checkConnection() {
  if (busy) return;
  busy = true; button.disabled = true; status.textContent = '正在连接本机 Codex…';
  try {
    let response;
    try { response = await chrome.runtime.sendMessage({type: 'checkBridge'}); }
    catch { throw new Error('插件已更新或连接中断，请刷新后重试。'); }
    if (!response?.ok) throw new Error(response?.error || '连接没有完成，请重试。');
    if (response.paired) {
      status.textContent = '连接成功。回到已经打开的 X 回复框即可开始生成。';
      button.textContent = '重新检查连接';
    } else {
      status.textContent = '本机 Codex 尚未连接。启动服务后，点击下面的按钮即可。';
      button.textContent = '连接 Codex';
    }
  } catch (error) { status.textContent = error.message; button.textContent = '连接 Codex'; }
  finally { busy = false; button.disabled = false; }
}
button.addEventListener('click', checkConnection);
checkConnection();
