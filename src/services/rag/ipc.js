// IPC bridge for the per-session RAG document store.
function registerRagIpc({ ipcMain, sessionRag, geminiRuntime, assemblyAiService, sendToRenderer }) {
  function clearSessionMemory() {
    // Conversation history exists only for the current session.
    try {
      const service = geminiRuntime?.getService?.();
      if (service && typeof service.clearHistory === 'function') {
        service.clearHistory();
      }
    } catch (_) {
      // no-op
    }
    try {
      assemblyAiService?.resetSttHistoryBuffers?.();
    } catch (_) {
      // no-op
    }
  }

  ipcMain.handle('rag-get-session', () => ({
    sessionId: sessionRag.getSessionId(),
    files: sessionRag.listFiles()
  }));

  ipcMain.handle('rag-upload-file', async (_event, payload = {}) => {
    try {
      const file = await sessionRag.addFile({
        name: payload.name,
        dataBase64: payload.dataBase64
      });
      return { success: true, file, files: sessionRag.listFiles() };
    } catch (error) {
      console.error('[RAG] upload failed:', error.message);
      return { success: false, error: error.message, files: sessionRag.listFiles() };
    }
  });

  ipcMain.handle('rag-remove-file', (_event, fileId) => {
    sessionRag.removeFile(fileId);
    return { success: true, files: sessionRag.listFiles() };
  });

  ipcMain.handle('rag-new-session', () => {
    const sessionId = sessionRag.newSession();
    clearSessionMemory();
    sendToRenderer('session-reset', { sessionId });
    return { success: true, sessionId, files: [] };
  });

  ipcMain.handle('rag-end-session', () => {
    const { sessionId } = sessionRag.endSession();
    clearSessionMemory();
    sendToRenderer('session-reset', { sessionId });
    return { success: true, sessionId, files: [] };
  });
}

module.exports = {
  registerRagIpc
};
