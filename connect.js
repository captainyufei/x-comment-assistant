// Runs only on the bridge's own pairing page; no credentials leave this page
// except when the user explicitly copies the code to their local clipboard.
const pairingInput = document.getElementById('pair-code');
const copyButton = document.getElementById('copy-code');
const showButton = document.getElementById('show-code');
const copyStatus = document.getElementById('copy-status');
copyButton.addEventListener('click', async () => {
  copyButton.disabled = true;
  try {
    await navigator.clipboard.writeText(pairingInput.value);
    copyStatus.textContent = '已复制。回到「X Comment Assistant」连接页粘贴并点击“连接”，再回到 X。';
  } catch {
    copyStatus.textContent = '复制未成功。点击“显示配对码”，选中配对码手动复制。';
  } finally { copyButton.disabled = false; }
});
showButton.addEventListener('click', () => {
  const show = pairingInput.type === 'password';
  pairingInput.type = show ? 'text' : 'password';
  showButton.textContent = show ? '隐藏配对码' : '显示配对码';
});
