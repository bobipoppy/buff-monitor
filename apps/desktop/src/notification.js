const { Notification } = require('electron');

let pushplusToken = '';

function setPushPlusToken(token) {
  pushplusToken = token;
}

async function sendWeChatNotification(title, content) {
  if (!pushplusToken) {
    console.warn('PushPlus token not configured');
    return false;
  }

  try {
    const response = await fetch('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: pushplusToken, title, content, template: 'markdown' }),
    });
    const result = await response.json();
    return result.code === 200;
  } catch (err) {
    console.error('WeChat push failed:', err.message);
    return false;
  }
}

function sendNativeNotification(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

function formatSignalMessage(itemName, signals, currentPrice) {
  const lines = [
    `## ${itemName}`,
    '',
    `**当前价格**: ¥${currentPrice}`,
    '',
    '### 信号',
    '',
    ...signals.map((s) => {
      const icon = s.type === 'buy_low' ? '🟢' : s.type === 'stop_loss' ? '🔴' : s.type === 'sell_high' ? '🟡' : '📈';
      return `- ${icon} **[${s.strength.toUpperCase()}]** ${s.message}`;
    }),
    '',
    `---`,
    `*${new Date().toLocaleString('zh-CN')}*`,
  ];
  return lines.join('\n');
}

module.exports = { setPushPlusToken, sendWeChatNotification, sendNativeNotification, formatSignalMessage };
