const fs = require('fs');
const path = require('path');
const { desktopCapturer, screen } = require('electron');

// Capture the primary display to a PNG file using Electron's native
// desktopCapturer. This replaces the `screenshot-desktop` package, whose
// bundled Windows helper (screenCapture_*.bat) fails on many machines
// ("Command failed"). No external process is spawned.
async function captureScreenToFile(screenshotPath) {
  const primary = screen.getPrimaryDisplay();
  const scaleFactor = primary.scaleFactor || 1;
  const width = Math.round(primary.size.width * scaleFactor);
  const height = Math.round(primary.size.height * scaleFactor);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  });

  if (!sources || sources.length === 0) {
    throw new Error('No screen source available for capture.');
  }

  // Prefer the source matching the primary display; fall back to the first.
  const primaryId = String(primary.id);
  const source = sources.find((s) => String(s.display_id) === primaryId) || sources[0];

  const pngBuffer = source.thumbnail.toPNG();
  if (!pngBuffer || pngBuffer.length === 0) {
    throw new Error('Screen capture produced an empty image.');
  }

  fs.writeFileSync(screenshotPath, pngBuffer);
}

function createScreenshotManager({ app, getMainWindow, getAppEnvironment, sendToRenderer }) {
  let screenshots = [];
  let screenshotSequence = 0;
  let screenshotInProgress = false;

  function nextScreenshotId() {
    screenshotSequence += 1;
    return `ss-${Date.now()}-${screenshotSequence}`;
  }

  function normalizeScreenshotEntry(entry) {
    if (!entry) return null;

    if (typeof entry === 'string') {
      return {
        id: null,
        path: entry,
        timestamp: null
      };
    }

    if (typeof entry.path === 'string') {
      return {
        id: typeof entry.id === 'string' ? entry.id : null,
        path: entry.path,
        timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null
      };
    }

    return null;
  }

  function getScreenshotsDir() {
    return app.isPackaged
      ? path.join(app.getPath('userData'), '.stealth_screenshots')
      : path.join(__dirname, '..', '..', '..', '..', '.stealth_screenshots');
  }

  function ensureScreenshotsDir() {
    const screenshotsDir = getScreenshotsDir();
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }
    return screenshotsDir;
  }

  function cleanupScreenshotFile(entry) {
    const normalizedEntry = normalizeScreenshotEntry(entry);
    if (normalizedEntry && fs.existsSync(normalizedEntry.path)) {
      fs.unlinkSync(normalizedEntry.path);
    }
  }

  async function takeStealthScreenshot() {
    if (screenshotInProgress) {
      console.log('Screenshot already in progress, skipping');
      return null;
    }

    const mainWindow = getMainWindow();
    const appEnvironment = getAppEnvironment();

    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window not available');
    }

    screenshotInProgress = true;
    try {
      console.log('Taking stealth screenshot...');
      const currentOpacity = mainWindow.getOpacity();
      const screenshotDelay = appEnvironment?.screenshotDelay || 300;

      mainWindow.setOpacity(0.01);
      await new Promise((resolve) => setTimeout(resolve, screenshotDelay));

      const screenshotsDir = ensureScreenshotsDir();
      const screenshotPath = path.join(screenshotsDir, `stealth-${Date.now()}.png`);

      await captureScreenToFile(screenshotPath);

      const screenshotEntry = {
        id: nextScreenshotId(),
        path: screenshotPath,
        timestamp: new Date().toISOString()
      };

      screenshots.push(screenshotEntry);
      if (screenshots.length > appEnvironment.maxScreenshots) {
        cleanupScreenshotFile(screenshots.shift());
      }

      mainWindow.setOpacity(currentOpacity);

      console.log(`Screenshot saved: ${screenshotPath}`);
      console.log(`Total screenshots: ${screenshots.length}`);

      sendToRenderer('screenshot-taken-stealth', {
        count: screenshots.length,
        screenshotId: screenshotEntry.id,
        timestamp: screenshotEntry.timestamp
      });

      return screenshotPath;
    } catch (error) {
      try {
        mainWindow.setOpacity(1.0);
      } catch (_) {
        // no-op
      }
      console.error('Stealth screenshot error:', error);
      throw error;
    } finally {
      screenshotInProgress = false;
    }
  }

  async function buildImagePartsFromScreenshots({ strict = true, includeIds = null, excludeIds = null } = {}) {
    const includeIdSet = Array.isArray(includeIds)
      ? new Set(includeIds.filter((id) => typeof id === 'string' && id.trim().length > 0))
      : null;
    const excludeIdSet = (excludeIds instanceof Set)
      ? excludeIds
      : (Array.isArray(excludeIds) ? new Set(excludeIds) : null);

    const usableEntries = [];

    for (const entry of screenshots) {
      const normalizedEntry = normalizeScreenshotEntry(entry);
      if (!normalizedEntry) continue;

      if (includeIdSet && (!normalizedEntry.id || !includeIdSet.has(normalizedEntry.id))) {
        continue;
      }

      if (excludeIdSet && normalizedEntry.id && excludeIdSet.has(normalizedEntry.id)) {
        continue;
      }

      if (fs.existsSync(normalizedEntry.path)) {
        usableEntries.push(normalizedEntry);
        continue;
      }

      console.error(`Screenshot file not found: ${normalizedEntry.path}`);
      if (strict) {
        throw new Error(`Screenshot file not found: ${normalizedEntry.path}`);
      }
    }

    const imageParts = usableEntries.map((entry) => {
      const imageData = fs.readFileSync(entry.path);
      return {
        inlineData: {
          data: imageData.toString('base64'),
          mimeType: 'image/png'
        }
      };
    });

    return {
      imageParts,
      entries: usableEntries
    };
  }

  function clearStealth() {
    screenshots.forEach((entry) => {
      cleanupScreenshotFile(entry);
    });

    screenshots = [];
    screenshotSequence = 0;

    console.log('All screenshots and context cleared');
    return { success: true };
  }

  function cleanupTransientResources() {
    screenshots.forEach((entry) => {
      cleanupScreenshotFile(entry);
    });

    screenshots = [];
    screenshotSequence = 0;
  }

  function getScreenshotsCount() {
    return screenshots.length;
  }

  function hasScreenshots() {
    return screenshots.length > 0;
  }

  return {
    buildImagePartsFromScreenshots,
    cleanupTransientResources,
    clearStealth,
    getScreenshotsCount,
    hasScreenshots,
    takeStealthScreenshot
  };
}

module.exports = {
  createScreenshotManager
};
