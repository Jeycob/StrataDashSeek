window.__ModuleLoader__.load({
  id: '@stratadashseek/output-continuation',
  factory: require => {
    const React = require('react');
    const namespace = 'homeai-output-continuation';
    const slot = 'conversation.chat.node';
    function OutputLimit({ t }) {
      return React.createElement('div', {
        role: 'status',
        'data-homeai-output-limit': '',
        style: { borderInlineStart: '2px solid currentColor', paddingInlineStart: '0.75rem' },
      }, React.createElement('strong', null, t('title')), React.createElement('div', null, t('description')));
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(namespace, {
          en: { title: 'Partial result saved', description: 'The reply stopped at the output limit. The conversation retains the output generated so far.' },
          cs: { title: 'Částečný výsledek uložen', description: 'Odpověď skončila na výstupním limitu. Její dosavadní část zůstává v chatu.' },
          zh: { title: '已保存部分结果', description: '回复在输出上限处结束，已生成的内容保留在对话中。' },
        }));
        ctx.slots.inject(slot, () => ctx.slots.register({
          name: slot, key: 'turn-max-tokens', priority: -1000, locale: namespace,
        }, OutputLimit));
      },
    };
  },
});
