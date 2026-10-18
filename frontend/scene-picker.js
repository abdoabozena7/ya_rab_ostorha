// Keep the native value as the protocol source; render an accessible themed popup.
export function installScenePicker(select) {
  const container=select.parentElement;
  const field=document.createElement('div');field.className='mission-scene-choice';
  const label=document.createElement('span');label.id='missionSceneLabel';label.textContent='Starting scene';
  const trigger=document.createElement('button');trigger.type='button';trigger.id='missionSceneTrigger';
  trigger.setAttribute('role','combobox');trigger.setAttribute('aria-haspopup','listbox');
  trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls','missionSceneOptions');
  trigger.setAttribute('aria-labelledby','missionSceneLabel missionSceneValue');
  const value=document.createElement('span');value.id='missionSceneValue';trigger.append(value);
  const popup=document.createElement('div');popup.id='missionSceneOptions';popup.hidden=true;
  popup.setAttribute('role','listbox');popup.setAttribute('aria-labelledby',label.id);
  const options=[...select.options];let active=select.selectedIndex;
  const rows=options.map((option,index)=>{
    const row=document.createElement('div');row.id=`missionSceneOption${index}`;row.setAttribute('role','option');
    const title=document.createElement('span');title.textContent=option.textContent.split(' · ')[0];row.append(title);
    const detail=option.textContent.split(' · ').slice(1).join(' · ');
    if(detail){const note=document.createElement('small');note.textContent=detail;row.append(note);}
    row.addEventListener('pointerdown',event=>event.preventDefault());
    row.addEventListener('click',()=>commit(index));popup.append(row);return row;
  });
  const sync=()=>{value.textContent=options[select.selectedIndex].textContent;rows.forEach((row,index)=>row.setAttribute('aria-selected',String(index===select.selectedIndex)));};
  const highlight=()=>{rows.forEach((row,index)=>row.dataset.active=String(index===active));trigger.setAttribute('aria-activedescendant',rows[active].id);};
  const close=()=>{popup.hidden=true;trigger.setAttribute('aria-expanded','false');trigger.removeAttribute('aria-activedescendant');};
  const open=()=>{active=select.selectedIndex;popup.hidden=false;trigger.setAttribute('aria-expanded','true');highlight();trigger.focus({preventScroll:true});popup.scrollIntoView({block:'nearest',behavior:'instant'});};
  const commit=index=>{select.selectedIndex=index;select.dispatchEvent(new Event('change',{bubbles:true}));sync();close();trigger.focus({preventScroll:true});};
  trigger.onclick=()=>popup.hidden?open():close();
  trigger.addEventListener('keydown',event=>{
    if(event.key==='Tab'){close();return;}
    if(event.key==='Escape'){if(!popup.hidden){event.preventDefault();event.stopPropagation();close();}return;}
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      event.preventDefault();
      if(popup.hidden)open();
      else if(event.key==='ArrowDown')active=(active+1)%rows.length;
      else if(event.key==='ArrowUp')active=(active+rows.length-1)%rows.length;
      if(event.key==='Home')active=0;if(event.key==='End')active=rows.length-1;
      highlight();return;
    }
    if(event.key==='Enter'||event.key===' '){event.preventDefault();if(popup.hidden)open();else commit(active);return;}
    if(event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
      const match=options.findIndex(option=>option.textContent.toLowerCase().startsWith(event.key.toLowerCase()));
      if(match!==-1){event.preventDefault();if(popup.hidden)open();active=match;highlight();}
    }
  });
  document.addEventListener('pointerdown',event=>{if(!field.contains(event.target))close();});
  field.addEventListener('focusout',event=>{if(!field.contains(event.relatedTarget))close();});
  select.addEventListener('change',sync);select.hidden=true;
  container.replaceWith(field);field.append(label,select,trigger,popup);sync();
  return {close};
}
