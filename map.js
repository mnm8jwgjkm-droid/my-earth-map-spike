"use strict";

// Deploy these credential-free assets together on the configured HTTPS origin.
// All Google objects stay in this adapter. The native bridge uses geographic values.
(() => {
  const bridgeVersion = 1;
  const earthRadiusMeters = 6371008.8;
  const maximumLatitude = 85;
  let map = null;
  let initialization = null;
  let mapsLoad = null;
  let loadRejection = null;
  let failed = false;
  let sawIdle = false;
  let sawTiles = false;
  let announcedReady = false;
  let readinessTimer = null;

  function post(type, payload = {}) {
    const handler = window.webkit?.messageHandlers?.myEarthMap;
    if (handler) {
      handler.postMessage({ version: bridgeVersion, type, ...payload });
    }
  }

  function reportError(code, message) {
    failed = true;
    clearTimeout(readinessTimer);
    post("error", { code, message });
  }

  function validateViewport(viewport) {
    const latitude = viewport?.center?.latitude;
    const longitude = viewport?.center?.longitude;
    const radius = viewport?.visibleRadiusMeters;
    const bearing = viewport?.bearingDegrees ?? 0;
    if (![latitude, longitude, radius, bearing].every(Number.isFinite) ||
        Math.abs(latitude) > maximumLatitude || Math.abs(longitude) > 180 ||
        radius < 100 || radius > 2000000) {
      throw new Error("invalid_viewport");
    }
    return { center: { latitude, longitude }, visibleRadiusMeters: radius, bearingDegrees: bearing };
  }

  function normalizeLongitude(value) {
    return ((value + 180) % 360 + 360) % 360 - 180;
  }

  function radians(degrees) { return degrees * Math.PI / 180; }
  function degrees(radiansValue) { return radiansValue * 180 / Math.PI; }

  // Radius is the geographic half-extent along the narrower viewport axis,
  // not a diagonal distance or a Google zoom level. fitBounds requests that framing.
  function viewportBounds(viewport) {
    const latitude = viewport.center.latitude;
    const longitude = viewport.center.longitude;
    const latitudeDelta = degrees(viewport.visibleRadiusMeters / earthRadiusMeters);
    const longitudeDelta = Math.min(179,
      latitudeDelta / Math.max(0.087, Math.cos(radians(latitude))));
    return {
      north: Math.min(maximumLatitude, latitude + latitudeDelta),
      south: Math.max(-maximumLatitude, latitude - latitudeDelta),
      east: normalizeLongitude(longitude + longitudeDelta),
      west: normalizeLongitude(longitude - longitudeDelta)
    };
  }

  function distanceMeters(first, second) {
    const latitudeDelta = radians(second.lat() - first.lat());
    const longitudeDelta = radians(second.lng() - first.lng());
    const a = Math.sin(latitudeDelta / 2) ** 2 +
      Math.cos(radians(first.lat())) * Math.cos(radians(second.lat())) *
      Math.sin(longitudeDelta / 2) ** 2;
    return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
  }

  function cameraState() {
    const center = map?.getCenter();
    const bounds = map?.getBounds();
    if (!center || !bounds) { return null; }
    const northEast = bounds.getNorthEast();
    const southWest = bounds.getSouthWest();
    const distanceToEdge = (latitude, longitude) => distanceMeters(center, {
      lat: () => latitude,
      lng: () => longitude
    });
    // For this top-down map, measure each edge at the center's latitude/longitude.
    // Returning the nearest edge matches command framing and supports relative zoom.
    const visibleRadiusMeters = Math.min(
      distanceToEdge(northEast.lat(), center.lng()),
      distanceToEdge(southWest.lat(), center.lng()),
      distanceToEdge(center.lat(), northEast.lng()),
      distanceToEdge(center.lat(), southWest.lng()));
    const state = {
      center: { latitude: center.lat(), longitude: center.lng() },
      visibleRadiusMeters,
      bearingDegrees: map.getHeading() ?? 0,
      pitchDegrees: map.getTilt() ?? 0
    };
    if (![state.center.latitude, state.center.longitude, visibleRadiusMeters,
          state.bearingDegrees, state.pitchDegrees].every(Number.isFinite) || visibleRadiusMeters <= 0) {
      return null;
    }
    return state;
  }

  function announceCamera() {
    if (failed) { return; }
    const camera = cameraState();
    if (camera) { post("camera", { camera }); }
  }

  function announceReadyIfPossible() {
    if (!failed && !announcedReady && sawIdle && sawTiles) {
      announcedReady = true;
      clearTimeout(readinessTimer);
      announceCamera();
      post("ready");
    }
  }

  function applyViewport(viewport) {
    // This isolated spike is deliberately top-down. fitBounds resets vector heading/tilt.
    map.fitBounds(viewportBounds(viewport), 24);
    map.setTilt(0);
    map.setHeading(0);
  }

  function loadMaps(apiKey) {
    if (mapsLoad) { return mapsLoad; }
    mapsLoad = new Promise((resolve, reject) => {
      loadRejection = reject;
      const script = document.createElement("script");
      const callbackName = "__myEarthGoogleMapsLoaded";
      const timeout = setTimeout(() => {
        delete window[callbackName];
        loadRejection = null;
        reject(new Error("maps_load_failed"));
      }, 20000);
      window[callbackName] = () => {
        clearTimeout(timeout);
        delete window[callbackName];
        loadRejection = null;
        resolve();
      };
      script.onerror = () => {
        clearTimeout(timeout);
        delete window[callbackName];
        loadRejection = null;
        reject(new Error("maps_load_failed"));
      };
      // The key is sent only to Google's runtime loader. It is never written to storage,
      // the hosted assets, the page URL, native messages, or application logs.
      const parameters = new URLSearchParams({
        key: apiKey,
        v: "quarterly",
        loading: "async",
        libraries: "maps,core",
        callback: callbackName
      });
      script.src = `https://maps.googleapis.com/maps/api/js?${parameters.toString()}`;
      script.async = true;
      document.head.appendChild(script);
    });
    return mapsLoad;
  }

  window.gm_authFailure = () => {
    reportError("google_authentication", "Google Maps rejected the development key. Check API access, billing, and authorized website restrictions.");
    loadRejection?.(new Error("google_authentication"));
  };

  async function createMap(apiKey, viewport) {
    await loadMaps(apiKey);
    if (failed) { return; }
    const [{ Map, RenderingType }, { ColorScheme }] = await Promise.all([
      google.maps.importLibrary("maps"),
      google.maps.importLibrary("core")
    ]);
    if (failed) { return; }
    document.getElementById("placeholder").hidden = true;
    map = new Map(document.getElementById("map"), {
      center: { lat: viewport.center.latitude, lng: viewport.center.longitude },
      zoom: 11,
      mapTypeId: "roadmap",
      renderingType: RenderingType.VECTOR,
      colorScheme: ColorScheme.DARK,
      tilt: 0,
      heading: 0,
      tiltInteractionEnabled: false,
      headingInteractionEnabled: false,
      gestureHandling: "greedy",
      keyboardShortcuts: true,
      fullscreenControl: false,
      streetViewControl: false,
      mapTypeControl: false,
      zoomControl: true
    });
    map.addListener("idle", () => {
      sawIdle = true;
      announceCamera();
      announceReadyIfPossible();
    });
    map.addListener("tilesloaded", () => {
      sawTiles = true;
      announceReadyIfPossible();
    });
    readinessTimer = setTimeout(() => {
      if (!announcedReady) {
        reportError("map_not_ready", "Google Maps did not finish loading. Check the connection and development configuration, then reload the map test.");
      }
    }, 30000);
    applyViewport(viewport);
  }

  async function initialize(apiKey, requestedViewport) {
    try {
      const viewport = validateViewport(requestedViewport);
      if (location.protocol !== "https:") {
        reportError("https_required", "Host the credential-free map page over HTTPS and configure its address locally.");
        return;
      }
      if (!window.webkit?.messageHandlers?.myEarthMap) { return; }
      if (map) { applyViewport(viewport); return; }
      if (typeof apiKey !== "string" || apiKey.length === 0 || apiKey.length > 512 || /\s/.test(apiKey)) {
        reportError("key_missing", "Provide the Google Maps development key through local app configuration.");
        return;
      }
      if (initialization) {
        await initialization;
        if (map && !failed) { applyViewport(viewport); }
        return;
      }
      initialization = createMap(apiKey, viewport);
      await initialization;
    } catch (error) {
      if (!failed) {
        if (error.message === "invalid_viewport") {
          reportError("invalid_viewport", "The requested geographic camera framing is invalid.");
        } else {
          reportError("maps_load_failed", "Google Maps could not load. Check the connection, HTTPS hosting, and development key configuration.");
        }
      }
    }
  }

  async function setViewport(requestedViewport) {
    try {
      const viewport = validateViewport(requestedViewport);
      if (!map || failed) {
        reportError("map_not_ready", "Wait for the map to become ready before sending a camera command.");
        return;
      }
      applyViewport(viewport);
    } catch {
      reportError("invalid_viewport", "The requested geographic camera framing is invalid.");
    }
  }

  window.myEarthMap = Object.freeze({ initialize, setViewport });
  post("hostReady");
})();
