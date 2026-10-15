const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const random = (min, max) => Math.floor(min + Math.random() * (max - min));

const INPUT_SELECTORS = [
  'input[name="text"]', 'textarea[name="text"]',
  '#text', '#text input', '#text textarea',
  'textarea[class*="Search"]', '[class*="SearchInput"] input',
  '.index-Controls input', 'input[type="text"][autofocus]',
  '.header-search__field',
];

// Only interact with editable fields. A matching ID can belong to a wrapper,
// and mobile layouts can keep a hidden desktop field before the visible one.
async function searchViaForm(page, query, device = 'desktop') {
  const selector = INPUT_SELECTORS.join(', ');
  try {
    await page.waitForFunction(selectors => Array.from(document.querySelectorAll(selectors)).some(el => {
      const r = el.getBoundingClientRect();
      return (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.disabled && !el.readOnly &&
        r.width > 0 && r.height > 0 && getComputedStyle(el).visibility === 'visible';
    }), { timeout: 8000 }, selector);
  } catch {
    console.log('  Search input: no matching visible element within 8s; checking candidates.');
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const fields = await page.$$(selector);
    try {
      for (const field of fields) {
        let stage = 'inspect';
        try {
          const info = await field.evaluate(el => {
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return {
              tag: el.tagName, id: el.id,
              editable: (el.tagName === 'TEXTAREA' ||
                (el.tagName === 'INPUT' && /^(text|search)$/.test(el.type))) &&
                !el.disabled && !el.readOnly && !el.closest('[inert]'),
              visible: r.width > 0 && r.height > 0 && style.visibility === 'visible' && style.display !== 'none',
            };
          });
          if (!info.editable || !info.visible) continue;
          console.log(`  Search input: ${info.tag}${info.id ? '#' + info.id : ''}, attempt ${attempt}`);
          stage = 'focus';
          await field.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
          if (device === 'mobile') await field.tap();
          else await field.click();
          await pause(random(180, 350));
          const focused = await field.evaluate(el => document.activeElement === el);
          if (!focused) {
            console.log('  Search input: interaction did not focus this field.');
            continue;
          }

          stage = 'clear';
          // Select only this field's text, independent of macOS/Windows shortcuts.
          await field.evaluate(el => el.select());
          await page.keyboard.press('Backspace');
          if (!await field.evaluate(el => document.activeElement === el && el.value === '')) {
            console.log('  Search input: clear failed or focus moved; skipping field.');
            continue;
          }

          stage = 'type';
          for (const character of query) {
            if (!await field.evaluate(el => document.activeElement === el)) {
              console.log('  Search input: focus lost while typing; query was not submitted.');
              throw new Error('focus lost while typing');
            }
            await page.keyboard.type(character, { delay: random(60, 190) });
            if (Math.random() < 0.12) await pause(random(200, 650));
          }
          if (!await field.evaluate((el, expected) =>
            document.activeElement === el && el.value === expected, query)) {
            console.log('  Search input: full query verification failed; query was not submitted.');
            throw new Error('field value does not exactly match the query');
          }
          console.log('  Search input: full query verified.');
          await pause(random(400, 800));
          if (!await field.evaluate((el, expected) =>
            document.activeElement === el && el.value === expected, query)) {
            console.log('  Search input: query or focus changed before submission.');
            return false;
          }

          stage = 'submit';
          // Restrict the button to the field's form, not another page widget.
          const buttonHandle = await field.evaluateHandle(el => {
            const form = el.form || el.closest('form');
            if (!form) return null;
            return Array.from(form.querySelectorAll('button, input[type="submit"]')).find(button => {
              const r = button.getBoundingClientRect();
              return button.type === 'submit' && !button.disabled && r.width > 0 && r.height > 0 &&
                getComputedStyle(button).visibility === 'visible';
            }) || null;
          });
          const before = page.url();
          try {
            const button = buttonHandle.asElement();
            if (button) {
              if (device === 'mobile') await button.tap();
              else await button.click();
            } else {
              await page.keyboard.press('Enter');
            }
          } finally {
            await buttonHandle.dispose();
          }
          stage = 'response';
          try {
            await page.waitForFunction(previous => location.href !== previous ||
              !!document.querySelector('.serp-item, #search-result, .Organic'),
            { timeout: 12000 }, before);
          } catch {
            console.log('  Search input: submitted, but no navigation or results appeared within 12s.');
            return false;
          }
          console.log('  Search input: submission produced a response.');
          return true;
        } catch (error) {
          // Avoid printing page URLs, field values or arbitrary page error text.
          console.log(`  Search input: ${stage} failed (${error.name || 'Error'}).`);
          if (stage === 'submit' || stage === 'response') return false;
        }
      }
    } finally {
      await Promise.all(fields.map(field => field.dispose().catch(() => {})));
    }
    if (attempt < 2) await pause(600);
  }
  console.log('  Search input: no editable candidate could complete the search.');
  return false;
}

module.exports = { searchViaForm };
