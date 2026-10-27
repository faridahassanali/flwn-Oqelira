const wordmark = new URL('./assets/flwn-wordmark-navy.svg', import.meta.url).href

/** Original Flwn wordmark, used without modification. The favicon is never a header logo. */
export const brand = () => `<span class="brand-product">Oqelira<span class="brand-attribution">by <img class="flwn-wordmark" src="${wordmark}" alt="Flwn"></span></span>`
