// Desktop shell: the game *is* a browser build, so Electron serves it over the same
// zero-dependency static server instead of file:// (ES module imports need an origin).
const { app, BrowserWindow } = require('electron');
const { startServer } = require('../server.cjs');

async function createWindow() {
  const server = await startServer({ port: 0 });
  const { port } = server.address();
  const win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 820,
    minHeight: 620,
    backgroundColor: '#0f1319',
    title: '战舰单数 FLEET',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadURL(`http://127.0.0.1:${port}/index.html`);
  win.on('closed', () => server.close());
}

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
