import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import WorkTime, { ExtraTimeAlerts } from './WorkTime';
import { AuthContext } from '../auth/context';
import { testAccount } from '../tests/authAccount';
import type { Role } from '../auth/context';
vi.mock('axios', async original => {const real=await original<typeof import('axios')>();return {...real,default:{...real.default,get:vi.fn(),post:vi.fn()}};});
const data={today:'2026-10-21',timeZone:'America/Los_Angeles',staff:[{id:'a',name:'Ari Employee',active:true,scheduleVersion:0,defaultMinutes:480,entries:[]}],items:[{staffId:'a',name:'Ari Employee',date:'2026-10-21',version:2,plannedMinutes:480,paidMillis:32400000,extraMillis:3600000,incomplete:false,status:'pending',reason:'',checkout:'2026-10-22T00:00:00Z',canCorrect:true}]};
function view(role:Role='editor',alerts=false){return <AuthContext.Provider value={{account:{...testAccount,role},ready:true,notice:'',serverUnavailable:false,signIn:vi.fn(),signOut:vi.fn(),changePassword:vi.fn(),retry:vi.fn()}}><MemoryRouter>{alerts?<ExtraTimeAlerts/>:<WorkTime/>}</MemoryRouter></AuthContext.Provider>;}
beforeEach(()=>{vi.resetAllMocks();vi.mocked(axios.get).mockResolvedValue({data:{data}});vi.mocked(axios.post).mockResolvedValue({data:{data:{saved:true}}});});
test.each(['viewer','teacher'] as const)('%s cannot load manager work-time data',role=>{render(view(role));expect(screen.getByRole('alert')).toHaveTextContent('Manager work-time access');expect(axios.get).not.toHaveBeenCalled();});
test('editors configure daily limits in hours and only the operational schedule is sent',async()=>{
 render(view());await screen.findByRole('option',{name:'Ari Employee'});fireEvent.change(screen.getByLabelText('Work-time employee'),{target:{value:'a'}});fireEvent.change(screen.getByLabelText('Approved hours per day'),{target:{value:'7.5'}});fireEvent.change(screen.getByLabelText('Reason for schedule change'),{target:{value:'Approved daily schedule'}});fireEvent.click(screen.getByRole('button',{name:'Save daily hours'}));
 await waitFor(()=>expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/staff/a/schedule'),{version:0,approvedHours:7.5,effectiveOn:'2026-10-21',reason:'Approved daily schedule'}));expect(screen.queryByLabelText(/SSN|Bank|rate/)).not.toBeInTheDocument();
});
test('a manager confirms extra work explicitly without changing checkouts or silently capping pay',async()=>{
 render(view());await screen.findByRole('heading',{name:'Ari Employee · 2026-10-21'});fireEvent.change(screen.getByLabelText('Extra-work review note'),{target:{value:'Stayed to assist with pickup'}});fireEvent.click(screen.getByRole('button',{name:'Confirm extra time was worked'}));
 await waitFor(()=>expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/staff/a/review'),{version:2,date:'2026-10-21',decision:'worked',reason:'Stayed to assist with pickup'}));
});
test('the home alert tells an editor that extra-time review is pending',async()=>{render(view('editor',true));expect(await screen.findByText('1 workday needs extra-time review.')).toBeVisible();expect(screen.getByRole('link',{name:'Review work time'})).toHaveAttribute('href','/work-time');});
