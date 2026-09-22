(function () {
  'use strict';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var nav = $('.site-nav');
  function syncNavOffset() {
    if (!nav) return 110;
    var h = nav.offsetHeight + 16;
    document.documentElement.style.setProperty('--nav-offset', h + 'px');
    return h;
  }
  function navOffset() {
    return syncNavOffset();
  }
  function onScroll() {
    if (nav) nav.classList.toggle('scrolled', window.scrollY > 10);
    var y = window.scrollY + navOffset();
    var current = '';
    $$('[data-section]').forEach(function (sec) {
      if (sec.offsetTop <= y) current = sec.id;
    });
    $$('.nav-links a[href^="#"]').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('href') === '#' + current);
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', syncNavOffset, { passive: true });
  syncNavOffset();
  onScroll();

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12 });
    $$('.reveal').forEach(function (el) { io.observe(el); });
  } else {
    $$('.reveal').forEach(function (el) { el.classList.add('in'); });
  }

  function bindSwitcher(rootSel, btnSel, paneSel) {
    $$(rootSel).forEach(function (root) {
      var btns = $$(btnSel, root);
      var panes = $$(paneSel, root);
      if (!btns.length || !panes.length) return;
      btns.forEach(function (btn) {
        btn.addEventListener('click', function () {
          var key = btn.getAttribute('data-target');
          btns.forEach(function (b) { b.classList.toggle('active', b === btn); });
          panes.forEach(function (p) {
            p.classList.toggle('active', p.getAttribute('data-pane') === key);
          });
          var bar = $('.story-progress > span', root);
          if (bar && btns.length) {
            var idx = btns.indexOf(btn);
            bar.style.width = (((idx + 1) / btns.length) * 100).toFixed(1) + '%';
          }
        });
      });
    });
  }

  bindSwitcher('.topic-switch', '.topic-btn', '.shot-pane');
  bindSwitcher('.feature-block', '.chip', '.shot-pane');
  bindSwitcher('.story-switch', '.story-step', '.shot-pane');

  /* roles */
  $$('.role-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var id = tab.getAttribute('data-role');
      $$('.role-tab').forEach(function (t) { t.classList.toggle('active', t === tab); });
      $$('.role-body').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-role') === id);
      });
    });
  });

  /* carousel */
  $$('.carousel').forEach(function (carousel) {
    var slides = $$('.carousel-slide', carousel);
    var dotsWrap = $('.carousel-dots', carousel);
    var caption = $('.carousel-caption', carousel);
    var idx = 0;
    var timer;

    slides.forEach(function (slide, i) {
      var dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'carousel-dot' + (i === 0 ? ' active' : '');
      dot.setAttribute('aria-label', 'ภาพที่ ' + (i + 1));
      dot.addEventListener('click', function () { go(i, true); });
      dotsWrap.appendChild(dot);
    });

    function go(i, user) {
      idx = (i + slides.length) % slides.length;
      slides.forEach(function (s, n) { s.classList.toggle('active', n === idx); });
      $$('.carousel-dot', carousel).forEach(function (d, n) { d.classList.toggle('active', n === idx); });
      if (caption) caption.textContent = slides[idx].getAttribute('data-caption') || '';
      if (user) restart();
    }

    function restart() {
      clearInterval(timer);
      timer = setInterval(function () { go(idx + 1); }, 5600);
    }

    var prevBtn = $('[data-carousel="prev"]', carousel);
    var nextBtn = $('[data-carousel="next"]', carousel);
    if (prevBtn) prevBtn.addEventListener('click', function () { go(idx - 1, true); });
    if (nextBtn) nextBtn.addEventListener('click', function () { go(idx + 1, true); });
    go(0);
    restart();
    carousel.addEventListener('mouseenter', function () { clearInterval(timer); });
    carousel.addEventListener('mouseleave', restart);
  });

  /* lightbox */
  var lb = $('#lightbox');
  var lbImg = $('#lightboxImg');
  function openLb(src, alt) {
    if (!lb || !lbImg || !src) return;
    lbImg.src = src;
    lbImg.alt = alt || '';
    lb.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeLb() {
    if (!lb) return;
    lb.classList.remove('open');
    document.body.style.overflow = '';
  }
  $$('img[data-zoom], .carousel-slide img, .shot-frame img').forEach(function (img) {
    img.addEventListener('click', function () {
      openLb(img.currentSrc || img.src, img.alt);
    });
  });
  if (lb) {
    lb.addEventListener('click', function (e) {
      if (e.target === lb || e.target.classList.contains('lightbox-close')) closeLb();
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeLb();
  });
})();
