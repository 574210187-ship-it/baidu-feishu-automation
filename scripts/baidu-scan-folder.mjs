const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const collectBaiduVideos = async ({ Runtime, Page, folderUrl, reload = false }) => {
  const evalPage = async (expression, timeout = 30000) => {
    const result = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true, timeout });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
    return result.result.value;
  };

  const location = await evalPage(`location.href`);
  // 三表共用扫描器：必须按调用方传入的目标目录判断当前页，不能写死旧的 zed 目录。
  const targetPath = decodeURIComponent(new URL(folderUrl).hash || folderUrl);
  if (!location.includes('/disk/main') || !decodeURIComponent(location).includes(targetPath.replace(/^.*path=/, '').replace(/&.*$/, ''))) {
    await Page.navigate({ url: folderUrl });
    await sleep(6000);
  } else if (reload) {
    await Page.reload({ ignoreCache: true });
    await sleep(6000);
  }

  const snapshot = async (scrollTop) => evalPage(`(() => {
    const visibleEnough = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const normalize = (name) => (name || '').replace(/\\s+/g, ' ').trim();
    const extractMp4Name = (raw) => {
      const text = normalize(raw);
      if (/\\.mp4$/i.test(text) && !text.slice(0, -4).includes('.mp4')) return text;
      return (text.match(/[^\\s]+\\.mp4/i) || [])[0] || '';
    };
    const pickRowInfo = (node, name) => {
      const row = node.closest('tr.wp-s-pan-table__body-row, tr.mouse-choose-item, .wp-s-pan-list__file-item, [data-id]') || node.parentElement;
      const text = normalize(row?.innerText || node.innerText || node.textContent || '');
      return {
        name,
        size: (text.match(/([\\d.]+\\s*[KMG]B?)/i) || [])[1]?.replace(/\\s+/g, '') || '',
        modified: (text.match(/(20\\d\\d-\\d\\d-\\d\\d\\s+\\d\\d:\\d\\d)/) || [])[1] || '',
        rowText: text.slice(0, 500)
      };
    };
    const collect = () => {
      const rows = [...document.querySelectorAll('tr.wp-s-pan-table__body-row, tr.mouse-choose-item')];
      const items = [];
      for (const row of rows) {
        if (!visibleEnough(row)) continue;
        const titleNode = row.querySelector('a[title$=".mp4"], span[title$=".mp4"], div[title$=".mp4"], a[title], span[title], div[title]');
        const raw = titleNode?.getAttribute('title') || titleNode?.innerText || titleNode?.textContent || row.innerText || '';
        const name = extractMp4Name(raw);
        if (!name) continue;
        items.push(pickRowInfo(row, name));
      }
      return items;
    };
    const scrollers = [...document.querySelectorAll('div, main, section')]
      .filter((el) => el.scrollHeight > el.clientHeight + 100)
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))
    const scroller = scrollers.find((el) => /pan|list|table|body|scroll|virtual/i.test(el.className?.toString?.() || '')) ||
      document.querySelector('.wp-s-pan-table__body') ||
      document.scrollingElement;
    if (${scrollTop} !== null) scroller.scrollTop = Math.max(0, Math.min(${scrollTop}, scroller.scrollHeight - scroller.clientHeight));
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    return {
      videos: collect(),
      scroll: {
        className: scroller.className?.toString?.() || '',
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight
      }
    };
  })()`, 10000);

  const seen = new Map();
  const add = (items) => {
    for (const item of items || []) {
      if (!seen.has(item.name)) seen.set(item.name, item);
    }
  };

  const first = await snapshot(0);
  add(first.videos);
  const stepSize = Math.max(260, Math.floor(first.scroll.clientHeight * 0.65));
  let pos = stepSize;
  let stagnant = 0;
  let lastHeight = first.scroll.scrollHeight;
  let lastTop = first.scroll.scrollTop;
  let finalScroll = first.scroll;

  for (let step = 0; step < 1200 && stagnant < 40; step += 1) {
    const maxTop = Math.max(0, lastHeight - finalScroll.clientHeight);
    const targetTop = Math.min(pos, maxTop);
    const before = seen.size;
    const current = await snapshot(targetTop);
    finalScroll = current.scroll;
    add(current.videos);
    await sleep(250);

    const heightChanged = current.scroll.scrollHeight !== lastHeight;
    const topChanged = current.scroll.scrollTop !== lastTop;
    const gotNew = seen.size > before;
    const atBottom = Math.abs(current.scroll.scrollTop - Math.max(0, current.scroll.scrollHeight - current.scroll.clientHeight)) < 5;

    if (gotNew || heightChanged || topChanged) {
      stagnant = 0;
    } else {
      stagnant += 1;
    }

    lastHeight = current.scroll.scrollHeight;
    lastTop = current.scroll.scrollTop;

    if (atBottom) {
      pos = current.scroll.scrollTop + stepSize;
      await sleep(900);
    } else {
      pos = current.scroll.scrollTop + stepSize;
    }
  }
  await snapshot(0).catch(() => null);

  const videos = [...seen.values()].sort((a, b) => {
    if (a.modified && b.modified && a.modified !== b.modified) return b.modified.localeCompare(a.modified);
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  return {
    videos,
    count: videos.length,
    scroll: finalScroll,
    scanMeta: { stepSize, stagnant, lastHeight }
  };
};
