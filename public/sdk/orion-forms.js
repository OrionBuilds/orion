(function(window) {
  'use strict';

  var Orion = window.Orion || {};
  var config = {
    baseUrl: '',
    debug: false
  };

  function log() {
    if (config.debug) {
      console.log.apply(console, ['[Orion]'].concat(Array.prototype.slice.call(arguments)));
    }
  }

  function getUtmParams() {
    var params = {};
    var search = window.location.search.substring(1);
    if (!search) return params;

    var pairs = search.split('&');
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i].split('=');
      var key = decodeURIComponent(pair[0]);
      if (key.indexOf('utm_') === 0) {
        params[key] = decodeURIComponent(pair[1] || '');
      }
    }
    return params;
  }

  function createIframe(src, options) {
    var iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.style.border = 'none';
    iframe.style.width = options.width || '100%';
    iframe.style.height = options.height || '500px';
    iframe.style.maxWidth = options.maxWidth || '600px';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allowtransparency', 'true');
    iframe.setAttribute('allow', 'geolocation');
    return iframe;
  }

  function createPopupOverlay() {
    var overlay = document.createElement('div');
    overlay.id = 'orion-popup-overlay';
    overlay.style.cssText = [
      'position: fixed',
      'top: 0',
      'left: 0',
      'right: 0',
      'bottom: 0',
      'background: rgba(0, 0, 0, 0.5)',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'z-index: 999999',
      'opacity: 0',
      'transition: opacity 0.3s ease'
    ].join(';');
    return overlay;
  }

  function createPopupContainer() {
    var container = document.createElement('div');
    container.id = 'orion-popup-container';
    container.style.cssText = [
      'background: white',
      'border-radius: 8px',
      'box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15)',
      'max-width: 90vw',
      'max-height: 90vh',
      'overflow: hidden',
      'position: relative',
      'transform: scale(0.9)',
      'transition: transform 0.3s ease'
    ].join(';');
    return container;
  }

  function createCloseButton(onClose) {
    var button = document.createElement('button');
    button.innerHTML = '&times;';
    button.style.cssText = [
      'position: absolute',
      'top: 10px',
      'right: 10px',
      'background: #f0f0f0',
      'border: none',
      'border-radius: 50%',
      'width: 32px',
      'height: 32px',
      'font-size: 20px',
      'cursor: pointer',
      'z-index: 10',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'color: #666'
    ].join(';');
    button.onclick = onClose;
    button.onmouseover = function() { button.style.background = '#e0e0e0'; };
    button.onmouseout = function() { button.style.background = '#f0f0f0'; };
    return button;
  }

  function handleMessage(event, options) {
    if (!config.baseUrl || event.origin !== new URL(config.baseUrl).origin) {
      return;
    }

    var data = event.data;
    if (!data || typeof data !== 'object') return;

    log('Received message:', data);

    if (data.type === 'orion:form:submit' && options.onSubmit) {
      options.onSubmit(data.payload);
    }

    if (data.type === 'orion:survey:complete' && options.onComplete) {
      options.onComplete(data.payload);
    }

    if (data.type === 'orion:error' && options.onError) {
      options.onError(data.error);
    }

    if (data.type === 'orion:close' && options.onClose) {
      options.onClose();
    }

    if (data.type === 'orion:resize') {
      var iframe = document.querySelector('#orion-embed-iframe');
      if (iframe && data.height) {
        iframe.style.height = data.height + 'px';
      }
    }
  }

  Orion.init = function(options) {
    if (!options.baseUrl) {
      console.error('[Orion] baseUrl is required');
      return;
    }
    config.baseUrl = options.baseUrl.replace(/\/$/, '');
    config.debug = options.debug || false;
    log('Initialized with baseUrl:', config.baseUrl);
  };

  Orion.renderForm = function(slug, containerId, options) {
    options = options || {};
    var container = document.getElementById(containerId);
    if (!container) {
      console.error('[Orion] Container not found:', containerId);
      return;
    }

    var utmParams = getUtmParams();
    var queryParams = new URLSearchParams({
      embed: 'true',
      referrer: document.referrer || '',
      landing_page: window.location.href
    });

    for (var key in utmParams) {
      queryParams.set(key, utmParams[key]);
    }

    var src = config.baseUrl + '/f/' + slug + '?' + queryParams.toString();
    var iframe = createIframe(src, options);
    iframe.id = 'orion-embed-iframe';

    container.innerHTML = '';
    container.appendChild(iframe);

    var messageHandler = function(event) {
      handleMessage(event, options);
    };
    window.addEventListener('message', messageHandler);

    log('Form rendered:', slug);

    return {
      destroy: function() {
        window.removeEventListener('message', messageHandler);
        container.innerHTML = '';
      }
    };
  };

  Orion.renderSurvey = function(slug, containerId, options) {
    options = options || {};
    var container = document.getElementById(containerId);
    if (!container) {
      console.error('[Orion] Container not found:', containerId);
      return;
    }

    var utmParams = getUtmParams();
    var queryParams = new URLSearchParams({
      embed: 'true',
      referrer: document.referrer || '',
      landing_page: window.location.href
    });

    for (var key in utmParams) {
      queryParams.set(key, utmParams[key]);
    }

    var src = config.baseUrl + '/s/' + slug + '?' + queryParams.toString();
    var iframe = createIframe(src, { height: options.height || '600px' });
    iframe.id = 'orion-embed-iframe';

    container.innerHTML = '';
    container.appendChild(iframe);

    var messageHandler = function(event) {
      handleMessage(event, options);
    };
    window.addEventListener('message', messageHandler);

    log('Survey rendered:', slug);

    return {
      destroy: function() {
        window.removeEventListener('message', messageHandler);
        container.innerHTML = '';
      }
    };
  };

  Orion.openFormPopup = function(slug, options) {
    options = options || {};

    var existingOverlay = document.getElementById('orion-popup-overlay');
    if (existingOverlay) {
      existingOverlay.remove();
    }

    var overlay = createPopupOverlay();
    var container = createPopupContainer();

    var closePopup = function() {
      overlay.style.opacity = '0';
      container.style.transform = 'scale(0.9)';
      setTimeout(function() {
        overlay.remove();
        window.removeEventListener('message', messageHandler);
        if (options.onClose) options.onClose();
      }, 300);
    };

    var closeButton = createCloseButton(closePopup);
    container.appendChild(closeButton);

    var utmParams = getUtmParams();
    var queryParams = new URLSearchParams({
      embed: 'true',
      popup: 'true',
      referrer: document.referrer || '',
      landing_page: window.location.href
    });

    for (var key in utmParams) {
      queryParams.set(key, utmParams[key]);
    }

    var src = config.baseUrl + '/f/' + slug + '?' + queryParams.toString();
    var iframe = createIframe(src, { width: '500px', height: '500px', maxWidth: '90vw' });
    iframe.style.display = 'block';
    container.appendChild(iframe);

    overlay.appendChild(container);
    document.body.appendChild(overlay);

    overlay.onclick = function(e) {
      if (e.target === overlay) closePopup();
    };

    setTimeout(function() {
      overlay.style.opacity = '1';
      container.style.transform = 'scale(1)';
    }, 10);

    var messageHandler = function(event) {
      handleMessage(event, options);
      if (event.data && event.data.type === 'orion:form:submit') {
        if (options.closeOnSubmit !== false) {
          setTimeout(closePopup, 1500);
        }
      }
    };
    window.addEventListener('message', messageHandler);

    log('Form popup opened:', slug);

    return { close: closePopup };
  };

  Orion.openSurveyPopup = function(slug, options) {
    options = options || {};

    var existingOverlay = document.getElementById('orion-popup-overlay');
    if (existingOverlay) {
      existingOverlay.remove();
    }

    var overlay = createPopupOverlay();
    var container = createPopupContainer();

    var closePopup = function() {
      overlay.style.opacity = '0';
      container.style.transform = 'scale(0.9)';
      setTimeout(function() {
        overlay.remove();
        window.removeEventListener('message', messageHandler);
        if (options.onClose) options.onClose();
      }, 300);
    };

    var closeButton = createCloseButton(closePopup);
    container.appendChild(closeButton);

    var utmParams = getUtmParams();
    var queryParams = new URLSearchParams({
      embed: 'true',
      popup: 'true',
      referrer: document.referrer || '',
      landing_page: window.location.href
    });

    for (var key in utmParams) {
      queryParams.set(key, utmParams[key]);
    }

    var src = config.baseUrl + '/s/' + slug + '?' + queryParams.toString();
    var iframe = createIframe(src, { width: '600px', height: '600px', maxWidth: '90vw' });
    iframe.style.display = 'block';
    container.appendChild(iframe);

    overlay.appendChild(container);
    document.body.appendChild(overlay);

    overlay.onclick = function(e) {
      if (e.target === overlay) closePopup();
    };

    setTimeout(function() {
      overlay.style.opacity = '1';
      container.style.transform = 'scale(1)';
    }, 10);

    var messageHandler = function(event) {
      handleMessage(event, options);
      if (event.data && event.data.type === 'orion:survey:complete') {
        if (options.closeOnComplete !== false) {
          setTimeout(closePopup, 2000);
        }
      }
    };
    window.addEventListener('message', messageHandler);

    log('Survey popup opened:', slug);

    return { close: closePopup };
  };

  Orion.version = '1.0.0';

  window.Orion = Orion;

})(window);
