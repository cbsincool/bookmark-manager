import path from 'node:path'
import url from 'node:url'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const extensionPath = path.join(__dirname, 'dist')

export const config = {
  runner: 'local',
  autoCompileOpts: {
    autoCompile: true,
    tsNodeOpts: {
      transpileOnly: true,
      esModuleResolution: true
    }
  },
  specs: ['./test/specs/**/*.js'],
  exclude: [],
  maxInstances: 1,
  capabilities: [{
    browserName: 'chrome',
    'goog:chromeOptions': {
      args: [
        `--load-extension=${extensionPath}`,
        '--no-sandbox',
        '--disable-gpu'
      ]
    }
  }],
  logLevel: 'info',
  bail: 0,
  baseUrl: '',
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  services: [],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 60000
  },
  
  // 获取扩展 ID 并打开 Side Panel
  before: async (capabilities) => {
    // 打开扩展页面获取 ID
    await browser.url('chrome://extensions/')
    
    // 启用开发者模式
    const devModeToggle = await $('#devMode')
    if (await devModeToggle.isExisting()) {
      await devModeToggle.click()
    }
    
    await browser.pause(1000)
    
    // 获取扩展 ID
    const extensionItem = await $('extensions-item')
    const extId = await extensionItem.getAttribute('id')
    global.extensionId = extId
    
    console.log('Extension ID:', extId)
    
    // 添加自定义命令：打开 Side Panel
    browser.addCommand('openSidePanel', async function() {
      const sidePanelUrl = `chrome-extension://${global.extensionId}/src/sidepanel/index.html`
      await this.url(sidePanelUrl)
      await this.pause(1000)
    })
    
    // 添加自定义命令：获取 console 日志
    browser.addCommand('getConsoleLogs', async function() {
      const logs = await this.getLog('browser')
      return logs.filter(log => log.level === 'ERROR' || log.level === 'SEVERE')
    })
  }
}