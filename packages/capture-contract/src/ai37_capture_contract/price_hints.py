"""Сканер ценоподобных узлов DOM карточки — общий для всех рендереров.

Исполняется в странице (`page.evaluate`) и возвращает `{hints, title_bottom}`: из `hints` агент
строит `PriceHint`. Одна строка на всех: рендерер со своей копией находил бы цены иначе, и Vision
получал бы разные кропы одной и той же карточки.
"""

#: Ценоподобные текстовые узлы карточки с прямоугольниками в координатах страницы.
#: Ищем число рядом с рублём внутри короткого элемента: длинный текст — это абзац, а не цена.
#: Возвращаем и низ заголовка h1: цены самой карточки лежат под ним, а «похожие товары» — ниже.
PRICE_HINTS_JS = """
() => {
  // Дробную часть отделяет запятая ИЛИ точка, вокруг которой на витрине бывает пробел: рубли
  // рисуют крупно, копейки мелко, и innerText склеивает их как «989, 64» или «989 ,64».
  // Лукбэхайнд не даёт началу совпадения попасть в середину числа («…088, 14»).
  const money = /(?<![\\d.,])(\\d[\\d\\s\\u00a0\\u202f]{0,9}(?:\\s{0,2}[.,]\\s{0,2}\\d{1,2})?)\\s*(?:₽|руб\\.?|р\\.|Р(?![а-яА-Я])|RUB)(?:\\s*\\/\\s*([^\\s,;)]{1,12}))?/u;
  const digits = /\\d/;
  const intLen = (m) => (m && m[1] ? m[1].replace(/\\D/g, '').length : 0);
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const struck = (el) => {
    for (let e = el, i = 0; e && i < 4; e = e.parentElement, i++) {
      if (['S', 'DEL', 'STRIKE'].includes(e.tagName)) return true;
      const d = getComputedStyle(e).textDecorationLine || '';
      if (d.includes('line-through')) return true;
    }
    return false;
  };
  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  // Собираем с запасом и обрезаем в конце по месту на странице, а не по месту в разметке. Раньше
  // брались первые 40 попавшихся подряд, и на Лемана ПРО цена товара — 157-й денежный узел,
  // после всех каруселей «похожие товары»: до неё очередь не доходила вовсе.
  while ((node = walker.nextNode()) && out.length < 300) {
    if (!digits.test(node.nodeValue || '')) continue;
    // Число и «₽» часто лежат в разных span, а рубли и копейки — в соседних («989» крупно,
    // «64» мелко). Поднимаемся до трёх предков и берём совпадение с САМЫМ ДЛИННЫМ числом: у
    // внутреннего span это был бы хвост «64 ₽/м²», у родителя — цельное «989, 64 ₽/м²».
    let el = null, m = null;
    for (let e = node.parentElement, i = 0; e && i < 3; i++, e = e.parentElement) {
      const own = norm(e.innerText || e.textContent);
      if (own.length > 60) break;
      const cur = money.exec(own);
      if (cur && intLen(cur) > intLen(m)) { m = cur; el = e; }
    }
    if (!el || !m || seen.has(el)) continue;
    seen.add(el);
    const st = getComputedStyle(el);
    // Прозрачная копия цены — не цена. На Лемана ПРО «989,64» лежит в разметке трижды: сама цена,
    // спрятанная копия и липкая панель покупки, которая проявляется прокруткой. У панели предок с
    // `opacity`, и наверху страницы он нулевой, а `visibility` у неё всё это время `visible` —
    // прежняя проверка её пропускала, и рамка доказательства уезжала на кредитное предложение
    // (прогоны 87c77d86 и 42bc38bf, сентябрь 2026). `checkVisibility` смотрит и на прозрачность
    // предков, и на `content-visibility`; без него остаётся прежняя грубая проверка.
    const visible = el.checkVisibility
      ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })
      : !(st.visibility === 'hidden' || st.display === 'none');
    if (!visible) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    // Узел, уведённый за левый или верхний край (мобильная панель, спрятанная transform-ом), в
    // кадр не попадает: раньше его координаты прижимались к нулю, и кроп резался по пустому месту.
    if (r.left + scrollX < 0 || r.top + scrollY < 0) continue;
    // Вправо за кадр уезжает карусель «похожие товары»: её прокручиваемая часть отдавала координаты
    // до x=5595 при кадре шириной 1440. На снимке этих цен нет, а места в списке они занимали.
    if (r.left + scrollX >= innerWidth) continue;
    // Подпись берём с запасом на двух уровнях предков: слово-исключение («от 351 ₽» у кнопки
    // рассрочки, «в месяц» у платежа) часто стоит выше самого числа, и без запаса не отсекалось.
    let around = norm(el.innerText || el.textContent);
    for (let e = el.parentElement, i = 0; e && i < 2; i++, e = e.parentElement) {
      const up = norm(e.innerText || e.textContent);
      if (up.length <= 80 && up.length > around.length) around = up;
    }
    out.push({
      text: m[0].trim().replace(/\\s*([.,])\\s*/g, '$1'), unit: m[2] || '',
      x: Math.max(0, Math.round(r.left + scrollX)), y: Math.max(0, Math.round(r.top + scrollY)),
      w: Math.round(r.width), h: Math.round(r.height),
      label: around.slice(0, 80), struck: struck(el),
      font_size: parseFloat(st.fontSize) || 0,
    });
  }
  // Сверху вниз: цена товара стоит в начале карточки, а цены каруселей — далеко внизу. Обрезаем
  // по этому порядку, чтобы место в списке доставалось тому, что ближе к началу страницы.
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  const h1 = document.querySelector('h1');
  const tb = h1 ? Math.round(h1.getBoundingClientRect().bottom + scrollY) : 0;
  return { hints: out.slice(0, 40), title_bottom: Math.max(0, tb) };
}
"""
