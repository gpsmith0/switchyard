// Native application menu. Standard macOS roles (so copy/paste, zoom and
// window management behave natively) plus Switchyard-specific entries.
"use strict";

const { app, Menu, shell } = require("electron");

function buildMenu({ getWindow, getOrigin }) {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Session",
          accelerator: "CmdOrCtrl+N",
          click: () => {
            const win = getWindow();
            const origin = getOrigin();
            if (win && origin) win.loadURL(`${origin}/#/`);
          },
        },
        {
          label: "Open in Browser",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => {
            const origin = getOrigin();
            if (origin) shell.openExternal(origin);
          },
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Switchyard Documentation",
          click: () => shell.openExternal("https://github.com/gpsmith0/switchyard#readme"),
        },
        {
          label: "Report an Issue",
          click: () => shell.openExternal("https://github.com/gpsmith0/switchyard/issues"),
        },
        {
          label: "Server Logs",
          click: () => {
            const os = require("node:os");
            const { join } = require("node:path");
            shell.showItemInFolder(join(os.homedir(), ".switchyard", "logs", "desktop-server.log"));
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
