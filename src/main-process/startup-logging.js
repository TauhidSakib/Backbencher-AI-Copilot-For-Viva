function logStartupConfiguration({
  appEnvironment,
  appState,
  assemblyAiSpeechModels,
  defaultAssemblyAiSpeechModel,
  programmingLanguages,
  defaultProgrammingLanguage
}) {
  const assemblyAiApiKey = typeof appState?.assemblyAiApiKey === 'string' ? appState.assemblyAiApiKey : '';

  console.log('Loaded .env from:', appEnvironment.envPath);
  console.log('Startup configuration:');
  console.log('  AI provider: ollama (local)');
  console.log(`  ASSEMBLY_AI_API_KEY (UI state): ${assemblyAiApiKey ? 'present' : 'missing'}`);
  console.log(`  HIDE_FROM_SCREEN_CAPTURE: ${appEnvironment.hideFromScreenCapture}`);
  console.log(`  MAX_SCREENSHOTS: ${appEnvironment.maxScreenshots}`);
  console.log(`  SCREENSHOT_DELAY: ${appEnvironment.screenshotDelay}`);
  console.log(`  NODE_ENV: ${appEnvironment.nodeEnv}`);
  console.log(`  NODE_OPTIONS: ${appEnvironment.nodeOptions}`);
  console.log(`  Default AssemblyAI speech model: ${defaultAssemblyAiSpeechModel}`);
  console.log(`  AssemblyAI speech models: ${assemblyAiSpeechModels.join(', ')}`);
  console.log(`  Default programming language: ${defaultProgrammingLanguage}`);
  console.log(`  Programming languages: ${programmingLanguages.join(', ')}`);
}

module.exports = {
  logStartupConfiguration
};
