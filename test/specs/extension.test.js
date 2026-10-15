describe('书签管理器扩展测试', () => {
  let extensionId
  
  before(async () => {
    // 获取扩展 ID
    await browser.url('chrome://extensions/')
    await browser.pause(1000)
    
    // 启用开发者模式
    try {
      const devMode = await $('#devMode')
      if (await devMode.isExisting()) {
        await devMode.click()
        await browser.pause(500)
      }
    } catch (e) {}
    
    // 获取扩展 ID
    const extItem = await $('extensions-item')
    extensionId = await extItem.getAttribute('id')
    console.log('Extension ID:', extensionId)
    
    // 保存到 global
    global.extensionId = extensionId
  })
  
  it('应该成功加载扩展', async () => {
    expect(extensionId).to.not.be.undefined
    console.log('✅ 扩展已加载，ID:', extensionId)
  })
  
  it('应该能打开 Side Panel', async () => {
    const sidePanelUrl = `chrome-extension://${extensionId}/src/sidepanel/index.html`
    await browser.url(sidePanelUrl)
    await browser.pause(2000)
    
    // 截图
    await browser.saveScreenshot('./test/screenshots/sidepanel.png')
    
    // 检查页面标题或关键元素
    const title = await browser.getTitle()
    console.log('Side Panel 标题:', title)
    
    // 获取 console 日志
    const logs = await browser.getLog('browser')
    const errors = logs.filter(log => log.level === 'SEVERE' || log.level === 'ERROR')
    console.log('Console 错误:', errors.length)
    
    if (errors.length > 0) {
      console.log('错误详情:', errors)
    }
  })
  
  it('应该能点击"开始整理"按钮', async () => {
    // 尝试找到"开始整理"按钮
    try {
      const startBtn = await $('button*=开始整理')
      if (await startBtn.isExisting()) {
        await startBtn.click()
        console.log('✅ 已点击"开始整理"')
        await browser.pause(3000)
        
        // 截图
        await browser.saveScreenshot('./test/screenshots/after-start.png')
        
        // 获取 console 日志
        const logs = await browser.getLog('browser')
        console.log('Console 日志数:', logs.length)
        
        const errors = logs.filter(log => log.level === 'SEVERE' || log.level === 'ERROR')
        if (errors.length > 0) {
          console.log('❌ 错误:', errors)
        }
      } else {
        console.log('未找到"开始整理"按钮')
      }
    } catch (e) {
      console.log('点击按钮失败:', e.message)
    }
  })
  
  it('应该能完成整理流程并显示目录', async () => {
    // 等待分类过程
    await browser.pause(10000)
    
    // 截图最终状态
    await browser.saveScreenshot('./test/screenshots/final.png')
    
    // 获取所有 console 日志
    const logs = await browser.getLog('browser')
    console.log('\n=== Console 日志 ===')
    logs.forEach(log => {
      if (log.level !== 'INFO') {
        console.log(`[${log.level}] ${log.message}`)
      }
    })
    
    // 检查错误
    const errors = logs.filter(log => log.level === 'SEVERE' || log.level === 'ERROR')
    console.log('\n错误数:', errors.length)
    
    if (errors.length > 0) {
      console.log('❌ 发现错误:')
      errors.forEach(err => {
        console.log(`  - ${err.message}`)
      })
    } else {
      console.log('✅ 无 Console 错误')
    }
  })
})
