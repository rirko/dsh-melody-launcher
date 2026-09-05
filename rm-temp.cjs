const fs = require('fs')
let s = fs.readFileSync('src/App.tsx', 'utf8')
const from = "  // TEMP(验证用，稍后删除)：F9/F10 键盘触发模式翻转\n  useEffect(() => {\n    const onKey = (event: KeyboardEvent) => {\n      if (event.key === 'F9') enterWheelchair()\n      if (event.key === 'F10') exitWheelchair()\n    }\n    window.addEventListener('keydown', onKey)\n    return () => window.removeEventListener('keydown', onKey)\n  }, [enterWheelchair, exitWheelchair])\n"
if (!s.includes(from)) throw new Error('TEMP block not found')
s = s.split(from).join('')
fs.writeFileSync('src/App.tsx', s)
console.log('temp trigger removed')
