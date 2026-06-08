<?php
/**
 * GASF Code Snippet #22 — "Calendar Print Button (page 8647)"
 *
 * Lives in the Code Snippets plugin (DB table _4UX_snippets, id=22), scope
 * front-end, active. This file is the version-controlled source of truth.
 *
 * NOTE: The Code Snippets `code` column stores everything BELOW the <?php line
 * (the plugin supplies the opening tag). The deploy step strips this first line
 * before writing to the DB; the <?php is here only so the file lints and reads
 * as PHP.
 *
 * Behavior: appends a "Print Calendar" button below the calendar on page 8647.
 * The headless-Chrome job on the Jabra box pre-renders one PDF per month
 * (calendar-YYYY-MM.pdf for the current month + the next 6), refreshed hourly.
 * The button links to the CURRENT month by default (works with no JS); the
 * data-cfasync="false" script upgrades the link to whichever month the visitor
 * is viewing and keeps it in sync as they use MEC's AJAX month navigation.
 * Styling is unchanged (.gasf-print-calendar-btn).
 */
add_filter( 'the_content', function( $content ) {
    if ( ! is_page( 8647 ) || ! in_the_loop() || ! is_main_query() ) {
        return $content;
    }

    $button = '<div class="gasf-print-calendar-wrap">'
            . '<a class="gasf-print-calendar-btn" href="' . esc_url( '/wp-content/uploads/calendar.pdf' ) . '" target="_blank" rel="noopener">'
            . '<span aria-hidden="true">&#128424;</span> Print Calendar'
            . '</a></div>';

    // NOWDOC: literal JS, no PHP interpolation. MEC marks the visible month with
    // .mec-month-container-selected whose id ends in YYYYMM; map that to the
    // matching PDF and re-apply whenever the calendar DOM changes (AJAX nav).
    $script = <<<'HTML'
<script data-cfasync="false">
(function(){
  function ym(){
    var s=document.querySelector(".mec-month-container-selected[id^='mec_monthly_view_month_']")||document.querySelector("[id^='mec_monthly_view_month_']");
    if(!s)return null;
    var m=(s.id.match(/(\d{6})$/)||[])[1]||s.getAttribute("data-month-id");
    return (m&&m.length===6)?m.slice(0,4)+"-"+m.slice(4,6):null;
  }
  function apply(){
    var a=document.querySelector(".gasf-print-calendar-btn");
    if(!a)return;
    var m=ym();
    // Bluehost serves these PDFs with a 24h cache; bust it hourly (the render
    // job refreshes hourly) so visitors always get the current PDF.
    var v=Math.floor(Date.now()/3600000);
    a.setAttribute("href","/wp-content/uploads/calendar"+(m?"-"+m:"")+".pdf?v="+v);
  }
  function init(){
    apply();
    var r=document.querySelector("#mec_skin_mec1")||document.querySelector(".mec-calendar");
    if(r&&window.MutationObserver){new MutationObserver(apply).observe(r,{subtree:true,childList:true,attributes:true,attributeFilter:["class","id"]});}
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
})();
</script>
HTML;

    return $content . $button . $script;
}, 20 );
