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
          en: { title: 'Reply incomplete', description: 'The reply stopped at the output limit. The conversation retains any text already generated.' },
          cs: { title: 'Odpověď neúplná', description: 'Odpověď skončila na výstupním limitu. Dosud vytvořený text zůstává v chatu.' },
          zh: { title: '回复未完成', description: '回复在输出上限处结束，已生成的文字保留在对话中。' },
        }));
        ctx.slots.inject(slot, () => ctx.slots.register({
          name: slot, key: 'turn-max-tokens', priority: -1000, locale: namespace,
        }, OutputLimit));
      },
    };
  },
});
