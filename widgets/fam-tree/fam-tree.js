import { loadCSS } from '../../scripts/aem.js';

// Load CSS - determine path based on script location
const scriptPath = import.meta.url;
const basePath = scriptPath.substring(0, scriptPath.lastIndexOf('/'));
const cssPath = `${basePath}/fam-tree.css`;
loadCSS(cssPath);

class FamilyTree {
  constructor(container) {
    this.container = container;
    this.data = null;
    this.persons = new Map();
    this.rootPerson = null;
    this.currentRoot = null;
    
    // Handle browser back/forward navigation
    window.addEventListener('popstate', (e) => {
      if (e.state && e.state.path) {
        // Reconstruct person from path (array of names)
        const pathNames = e.state.path;
        let currentPerson = null;
        
        for (const name of pathNames) {
          const person = Array.from(this.persons.values()).find(p => p.name === name);
          if (person) {
            currentPerson = person;
          } else {
            break;
          }
        }
        
        if (currentPerson) {
          this.currentRoot = currentPerson;
          this.render();
        } else {
          this.currentRoot = this.rootPerson;
          this.render();
        }
      } else {
        this.currentRoot = this.rootPerson;
        this.render();
      }
    });
    
    this.init();
  }

  async init() {
    const loadingEl = this.container.querySelector('.fam-tree-loading');
    const errorEl = this.container.querySelector('.fam-tree-error');
    const wrapperEl = this.container.querySelector('.fam-tree-wrapper');
    
    try {
      const response = await fetch('/stammbaum.json');
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      
      const json = await response.json();
      this.data = json.data || json;
      
      loadingEl.style.display = 'none';
      this.buildTree();
      
      // Check URL for person ID on initial load
      this.loadFromURL();
      
      this.render();
      
      // Setup controls
      this.setupControls();
      
      // Setup search
      this.setupSearch();
    } catch (error) {
      loadingEl.style.display = 'none';
      errorEl.style.display = 'block';
      errorEl.textContent = `Error loading family tree: ${error.message}`;
      console.error('Family tree error:', error);
    }
  }

  buildTree() {
    // First pass: collect all persons and their events
    this.data.forEach(record => {
      if (!record.Person) return;
      
      const anchorId = record.AnchorId || record.Person;
      if (!this.persons.has(anchorId)) {
        this.persons.set(anchorId, {
          id: anchorId,
          name: record.Person,
          events: [],
          children: [],
          parentId: null
        });
      }
      
      const person = this.persons.get(anchorId);
      
      // Add event
      const event = {
        type: record.Ereignis,
        date: this.convertExcelDate(record.Datum) || '',
        partner: record.Partner || '',
        partnerBirthDeath: record.PartnerGeburtTod || '',
        parent1: record.Eltern1 || '',
        parent2: record.Eltern2 || ''
      };
      
      person.events.push(event);
      
      // Set parent relationship
      // ParentId "0" refers to the person with AnchorId "0" (Peter), not "no parent"
      if (record.ParentId && record.ParentId !== '' && record.ParentId !== null) {
        // Convert to string for consistent comparison
        const parentId = String(record.ParentId);
        if (parentId === '0') {
          // ParentId "0" means parent is the person with AnchorId "0"
          person.parentId = '0';
        } else {
          person.parentId = parentId;
        }
      } else if (record.Eltern1) {
        // Try to find parent by name if no ParentId
        const parent = Array.from(this.persons.values()).find(p => 
          p.name === record.Eltern1 || p.name.includes(record.Eltern1)
        );
        if (parent) {
          person.parentId = parent.id;
        }
      }
    });

    // Second pass: build parent-child relationships
    this.persons.forEach((person, id) => {
      if (person.parentId) {
        const parent = this.persons.get(person.parentId);
        if (parent) {
          parent.children.push(person);
        } else {
          // Try to find parent by name if ParentId doesn't match
          const parentName = person.events.find(e => e.parent1)?.parent1;
          if (parentName) {
            const parentByName = Array.from(this.persons.values()).find(p => 
              p.name === parentName || p.name.includes(parentName) || parentName.includes(p.name)
            );
            if (parentByName && !parentByName.children.find(c => c.id === person.id)) {
              parentByName.children.push(person);
              person.parentId = parentByName.id;
            }
          }
        }
      } else {
        // Try to find parent by name even if no ParentId
        const parentName = person.events.find(e => e.parent1)?.parent1;
        if (parentName) {
          const parent = Array.from(this.persons.values()).find(p => 
            p.name === parentName || p.name.includes(parentName) || parentName.includes(p.name)
          );
          if (parent && !parent.children.find(c => c.id === person.id)) {
            parent.children.push(person);
            person.parentId = parent.id;
          }
        }
      }
    });
    
    // Sort children by birth date
    this.persons.forEach(person => {
      person.children.sort((a, b) => {
        const aBirth = this.getBirthDate(a);
        const bBirth = this.getBirthDate(b);
        if (!aBirth) return 1;
        if (!bBirth) return -1;
        return aBirth - bBirth;
      });
    });

    // Find root person - prioritize person with ID 0 (Peter)
    // Peter (AnchorId "0") should have no parent (null/empty ParentId)
    const personWithId0 = this.persons.get('0');
    if (personWithId0 && (!personWithId0.parentId || personWithId0.parentId === '')) {
      // Person with ID 0 exists and has no parent - this is the root
      this.rootPerson = personWithId0;
    } else {
      // Fallback: find person with no parent (null or empty, not "0")
      // Note: ParentId "0" means parent is Peter, not "no parent"
      const personsWithNoParent = Array.from(this.persons.values())
        .filter(p => !p.parentId || p.parentId === '');
      
      if (personsWithNoParent.length > 0) {
        // Find person with earliest birth date
        this.rootPerson = personsWithNoParent.reduce((earliest, current) => {
          const earliestBirth = this.getBirthDate(earliest);
          const currentBirth = this.getBirthDate(current);
          if (!earliestBirth) return current;
          if (!currentBirth) return earliest;
          return earliestBirth < currentBirth ? earliest : current;
        });
      } else {
        // Fallback: use first person
        this.rootPerson = Array.from(this.persons.values())[0];
      }
    }
    
    this.currentRoot = this.rootPerson;
  }

  convertExcelDate(excelDate) {
    // Dates are either:
    // - Years if less than 10000 (e.g., "1485", "1515")
    // - Excel serial dates if 10000 or greater
    if (!excelDate || excelDate === '' || excelDate === '0' || excelDate === 0) return '';
    
    // Check if it's a number
    const numDate = parseFloat(excelDate);
    if (isNaN(numDate) || numDate <= 0) {
      // Not a valid number, return as is (might be a regular date string)
      return String(excelDate);
    }
    
    // If less than 10000, treat as a year
    if (numDate < 10000) {
      return String(Math.floor(numDate));
    }
    
    // Otherwise, treat as Excel date serial number
    // Excel epoch: Dec 30, 1899 = day 0, Jan 1, 1900 = day 1
    // Excel incorrectly treats 1900 as a leap year (it wasn't), creating a false Feb 29, 1900
    const excelEpoch = new Date(1899, 11, 30); // Dec 30, 1899
    
    // Excel serial 1 = Jan 1, 1900, but Dec 30, 1899 + 0 days = Dec 30, 1899
    // So we need to add 2 days for serial 1 to get Jan 1, 1900
    // For dates >= 60 (March 1, 1900), Excel counts the false Feb 29, 1900
    // JavaScript Date correctly skips it, so we need to add 1 extra day
    let daysToAdd;
    if (numDate >= 60) {
      // For dates on or after March 1, 1900: add 1 extra day for the false leap day
      daysToAdd = numDate; // This is (numDate - 1) + 1
    } else {
      // For dates before March 1, 1900: add 2 days (serial 1 = Jan 1, 1900)
      daysToAdd = numDate + 1; // This is (numDate - 1) + 2
    }
    
    const date = new Date(excelEpoch.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
    
    // Check if date is valid
    if (isNaN(date.getTime())) {
      return String(excelDate);
    }
    
    // Format as YYYY-MM-DD
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    return `${year}-${month}-${day}`;
  }

  getBirthDate(person) {
    const birthEvent = person.events.find(e => e.type === 'Geburt');
    if (birthEvent && birthEvent.date) {
      // Date is already converted, extract year
      const dateStr = birthEvent.date;
      // Try to extract year from YYYY-MM-DD format or just YYYY
      const yearMatch = dateStr.match(/^(\d{4})/);
      if (yearMatch) {
        const year = parseInt(yearMatch[1]);
        if (!isNaN(year)) return year;
      }
    }
    return null;
  }

  setupControls() {
    const expandBtn = this.container.querySelector('#fam-tree-expand-all');
    const collapseBtn = this.container.querySelector('#fam-tree-collapse-all');
    
    // Remove expand/collapse buttons since functionality is removed
    expandBtn?.remove();
    collapseBtn?.remove();
  }

  setupSearch() {
    const searchInput = this.container.querySelector('#fam-tree-search');
    const searchResults = this.container.querySelector('#fam-tree-search-results');
    
    if (!searchInput || !searchResults) return;
    
    let searchTimeout;
    
    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.trim();
      
      clearTimeout(searchTimeout);
      
      if (query.length < 2) {
        searchResults.classList.remove('show');
        return;
      }
      
      searchTimeout = setTimeout(() => {
        this.performSearch(query, searchResults);
      }, 200);
    });
    
    // Hide results when clicking outside
    document.addEventListener('click', (e) => {
      if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
        searchResults.classList.remove('show');
      }
    });
    
    // Handle keyboard navigation
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchResults.classList.remove('show');
        searchInput.blur();
      }
    });
  }

  performSearch(query, resultsContainer) {
    const queryLower = query.toLowerCase();
    const matches = [];
    
    // Search all persons by name and spouse names
    this.persons.forEach((person) => {
      const nameLower = person.name.toLowerCase();
      let matchReason = null;
      let matchedSpouse = null;
      
      // Check if person name matches
      if (nameLower.includes(queryLower)) {
        matchReason = 'name';
        matches.push({ person, matchReason, matchedSpouse: null });
      } else {
        // Check if any spouse name matches
        const marriages = person.events.filter(e => e.type === 'Heirat' && e.partner);
        for (const marriage of marriages) {
          const spouseNameLower = marriage.partner.toLowerCase();
          if (spouseNameLower.includes(queryLower)) {
            matchReason = 'spouse';
            matchedSpouse = marriage.partner;
            matches.push({ person, matchReason, matchedSpouse });
            break; // Only add once per person even if multiple spouses match
          }
        }
      }
    });
    
    // Sort by relevance (name matches first, then spouse matches, then by name)
    matches.sort((a, b) => {
      if (a.matchReason === 'name' && b.matchReason === 'spouse') return -1;
      if (a.matchReason === 'spouse' && b.matchReason === 'name') return 1;
      
      const aExact = a.person.name.toLowerCase().startsWith(queryLower);
      const bExact = b.person.name.toLowerCase().startsWith(queryLower);
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      return a.person.name.localeCompare(b.person.name);
    });
    
    // Limit to 20 results
    const limitedMatches = matches.slice(0, 20);
    
    resultsContainer.innerHTML = '';
    
    if (limitedMatches.length === 0) {
      const noResults = document.createElement('div');
      noResults.className = 'fam-tree-search-result-item';
      noResults.textContent = 'No matches found';
      noResults.style.cursor = 'default';
      noResults.style.color = '#6c757d';
      resultsContainer.appendChild(noResults);
    } else {
      limitedMatches.forEach(({ person, matchReason, matchedSpouse }) => {
        const item = document.createElement('div');
        item.className = 'fam-tree-search-result-item';
        
        // Get birth and death dates
        const birthEvent = person.events.find(e => e.type === 'Geburt');
        const deathEvent = person.events.find(e => e.type === 'Tod');
        const birthDate = birthEvent?.date || '';
        const deathDate = deathEvent?.date || '';
        
        // Create name with highlights
        const nameEl = document.createElement('div');
        nameEl.className = 'fam-tree-search-result-name';
        
        if (matchReason === 'spouse') {
          // Show person name, then "spouse of" with highlighted spouse name
          nameEl.innerHTML = `${person.name} <span style="color: #6c757d; font-weight: normal;">(Ehepartner: ${this.highlightText(matchedSpouse, query)})</span>`;
        } else {
          nameEl.innerHTML = this.highlightText(person.name, query);
        }
        item.appendChild(nameEl);
        
        // Create dates
        if (birthDate || deathDate) {
          const datesEl = document.createElement('div');
          datesEl.className = 'fam-tree-search-result-dates';
          const parts = [];
          if (birthDate) {
            parts.push(`* ${birthDate}`);
          }
          if (deathDate) {
            parts.push(`† ${deathDate}`);
          }
          datesEl.textContent = `(${parts.join(' - ')})`;
          item.appendChild(datesEl);
        }
        
        // Click handler
        item.addEventListener('click', () => {
          const searchInput = this.container.querySelector('#fam-tree-search');
          this.navigateToPerson(person);
          resultsContainer.classList.remove('show');
          if (searchInput) searchInput.value = '';
        });
        
        resultsContainer.appendChild(item);
      });
    }
    
    resultsContainer.classList.add('show');
  }

  highlightText(text, query) {
    if (!query) return text;
    
    const regex = new RegExp(`(${this.escapeRegex(query)})`, 'gi');
    return text.replace(regex, '<span class="fam-tree-search-highlight">$1</span>');
  }

  escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  navigateToPerson(person) {
    this.currentRoot = person;
    this.updateURL(person);
    this.render();
    // Scroll to the selected person after a short delay to allow rendering
    setTimeout(() => {
      this.scrollToSelectedPerson();
    }, 100);
  }

  scrollToSelectedPerson() {
    const wrapperEl = this.container.querySelector('.fam-tree-wrapper');
    if (!wrapperEl) return;
    
    // Find the current person's element - it's in the last generation
    const generations = wrapperEl.querySelectorAll('.fam-tree-generation');
    if (generations.length === 0) return;
    
    const lastGeneration = generations[generations.length - 1];
    const currentPersonEl = lastGeneration.querySelector('.fam-tree-person-wrapper .fam-tree-person');
    
    if (currentPersonEl) {
      // Highlight the selected person
      currentPersonEl.classList.add('fam-tree-person-selected');
      
      // Scroll the person into view
      currentPersonEl.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      });
      
      // Also scroll wrapper to bottom to ensure visibility
      setTimeout(() => {
        wrapperEl.scrollTo({
          top: wrapperEl.scrollHeight,
          behavior: 'smooth'
        });
      }, 300);
      
      // Remove highlight after animation
      setTimeout(() => {
        currentPersonEl.classList.remove('fam-tree-person-selected');
      }, 2000);
    }
  }

  getBreadcrumbPath(person) {
    const path = [];
    const visited = new Set();
    let current = person;
    
    // Traverse up to root
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      path.unshift(current);
      if (current.parentId && current.parentId !== '0' && current.parentId !== '') {
        const parent = this.persons.get(current.parentId);
        if (parent) {
          current = parent;
        } else {
          break;
        }
      } else {
        break;
      }
    }
    
    // If we didn't reach the root, add it
    if (path.length === 0 || path[0].id !== this.rootPerson.id) {
      path.unshift(this.rootPerson);
    }
    
    return path;
  }

  updateURL(person) {
    const url = new URL(window.location);
    const path = this.getBreadcrumbPath(person);
    
    // Build path string like breadcrumb: names separated by ">"
    const pathNames = path.map(p => p.name);
    const pathString = pathNames.join(' > ');
    
    if (path.length > 1 || (path.length === 1 && path[0].id !== this.rootPerson.id)) {
      url.searchParams.set('path', encodeURIComponent(pathString));
    } else {
      url.searchParams.delete('path');
    }
    
    window.history.pushState({ path: pathNames }, '', url);
  }

  loadFromURL() {
    const urlParams = new URLSearchParams(window.location.search);
    const pathParam = urlParams.get('path');
    
    if (pathParam) {
      // Decode and split by " > " to get names
      const decoded = decodeURIComponent(pathParam);
      const pathNames = decoded.split(' > ');
      let currentPerson = null;
      
      // Try to find person by following the path
      for (const name of pathNames) {
        // Find person by name
        const person = Array.from(this.persons.values()).find(p => p.name === name.trim());
        
        if (person) {
          currentPerson = person;
        } else {
          // If we can't find a person in the path, break
          break;
        }
      }
      
      if (currentPerson) {
        this.currentRoot = currentPerson;
        // Update history state without triggering navigation
        window.history.replaceState({ path: pathNames }, '', window.location);
        return;
      }
    }
    
    // Default to root person
    this.currentRoot = this.rootPerson;
  }

  render() {
    const wrapperEl = this.container.querySelector('.fam-tree-wrapper');
    wrapperEl.innerHTML = '';
    
    if (!this.currentRoot) {
      wrapperEl.innerHTML = '<div class="fam-tree-loading">No root person found</div>';
      return;
    }
    
    // Update breadcrumb
    this.updateBreadcrumb();
    
    const treeEl = document.createElement('div');
    treeEl.className = 'fam-tree';
    
    // Build path from root to current person
    const path = this.getPathToRoot(this.currentRoot);
    
    // Render the path (ancestors from root to parent of current)
    if (path.length > 1) {
      // Render ancestors (excluding current person)
      for (let i = 0; i < path.length - 1; i++) {
        const ancestor = path[i];
        const ancestorWrapper = document.createElement('div');
        ancestorWrapper.className = 'fam-tree-generation';
        this.renderPersonCard(ancestor, ancestorWrapper);
        treeEl.appendChild(ancestorWrapper);
      }
    }
    
    // Render current person with direct children only
    const currentWrapper = document.createElement('div');
    currentWrapper.className = 'fam-tree-generation';
    this.renderPersonWithDirectChildren(this.currentRoot, currentWrapper);
    treeEl.appendChild(currentWrapper);
    
    wrapperEl.appendChild(treeEl);
  }

  getPathToRoot(person) {
    const path = [];
    const visited = new Set();
    let current = person;
    
    // Traverse up to root, avoiding cycles
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      path.push(current);
      if (current.parentId && current.parentId !== '0' && current.parentId !== '') {
        const parent = this.persons.get(current.parentId);
        if (parent) {
          current = parent;
        } else {
          break;
        }
      } else {
        break;
      }
    }
    
    // If we didn't reach the root, add it
    if (path.length === 0 || path[path.length - 1].id !== this.rootPerson.id) {
      path.push(this.rootPerson);
    }
    
    // Reverse to get path from root to person
    return path.reverse();
  }

  renderPersonCard(person, container) {
    const personEl = document.createElement('div');
    personEl.className = 'fam-tree-person';
    
    // Person name
    const nameEl = document.createElement('div');
    nameEl.className = 'fam-tree-person-name';
    nameEl.textContent = person.name;
    personEl.appendChild(nameEl);
    
    // Birth and death dates below name
    const birthEvent = person.events.find(e => e.type === 'Geburt');
    const deathEvent = person.events.find(e => e.type === 'Tod');
    const birthDate = birthEvent?.date || '';
    const deathDate = deathEvent?.date || '';
    
    if (birthDate || deathDate) {
      const datesEl = document.createElement('div');
      datesEl.className = 'fam-tree-person-dates';
      const parts = [];
      if (birthDate) {
        parts.push(`* ${birthDate}`);
      }
      if (deathDate) {
        parts.push(`† ${deathDate}`);
      }
      datesEl.textContent = `(${parts.join(' - ')})`;
      personEl.appendChild(datesEl);
    }
    
    // Events (marriages, etc.)
    const eventsEl = document.createElement('div');
    eventsEl.className = 'fam-tree-person-events';
    
    const uniqueEvents = this.getUniqueEvents(person.events);
    const filteredEvents = uniqueEvents.filter(e => e.type !== 'Geburt' && e.type !== 'Tod');
    const marriages = filteredEvents.filter(e => e.type === 'Heirat');
    const divorces = filteredEvents.filter(e => e.type === 'Scheidung');
    const otherEvents = filteredEvents.filter(e => e.type !== 'Heirat' && e.type !== 'Scheidung');
    
    // Sort marriages by date
    marriages.sort((a, b) => {
      const dateA = a.date || '';
      const dateB = b.date || '';
      const yearA = parseInt(dateA) || 0;
      const yearB = parseInt(dateB) || 0;
      if (yearA !== yearB) return yearA - yearB;
      return dateA.localeCompare(dateB);
    });
    
    // Match marriages with divorces by partner name
    const marriagesWithDivorces = marriages.map((marriage, index) => {
      // Find matching divorce (same partner)
      const matchingDivorce = divorces.find(d => 
        d.partner === marriage.partner || 
        (marriage.partner && d.partner && marriage.partner.includes(d.partner)) ||
        (d.partner && marriage.partner && d.partner.includes(marriage.partner))
      );
      
      return {
        ...marriage,
        divorceDate: matchingDivorce?.date || null,
        index: index + 1
      };
    });
    
    // Display marriages
    marriagesWithDivorces.forEach((marriage) => {
      const marriageEl = document.createElement('div');
      marriageEl.className = 'fam-tree-event';
      
      const parts = [`H${marriage.index}:`];
      
      // Date range: start date - end date (if divorce exists)
      if (marriage.date) {
        if (marriage.divorceDate) {
          parts.push(`${marriage.date} - ${marriage.divorceDate}`);
        } else {
          parts.push(marriage.date);
        }
      }
      
      if (marriage.partner) {
        parts.push(marriage.partner);
      }
      if (marriage.partnerBirthDeath) {
        parts.push(marriage.partnerBirthDeath);
      }
      
      marriageEl.textContent = parts.join(' ');
      eventsEl.appendChild(marriageEl);
    });
    
    // Display other events
    otherEvents.forEach(event => {
      const eventEl = document.createElement('div');
      eventEl.className = 'fam-tree-event';
      
      const typeEl = document.createElement('span');
      typeEl.className = 'fam-tree-event-type';
      typeEl.textContent = event.type + ':';
      
      const dateEl = document.createElement('span');
      dateEl.className = 'fam-tree-event-date';
      dateEl.textContent = event.date || 'unbekannt';
      
      eventEl.appendChild(typeEl);
      eventEl.appendChild(dateEl);
      eventsEl.appendChild(eventEl);
    });
    
    personEl.appendChild(eventsEl);
    
    // Show descendant count for all persons
    const descendantCount = this.countDescendants(person);
    if (descendantCount > 0) {
      const countEl = document.createElement('div');
      countEl.className = 'fam-tree-descendant-count';
      countEl.textContent = `${descendantCount} Nachkomme${descendantCount !== 1 ? 'n' : ''}`;
      personEl.appendChild(countEl);
    }
    
    // Add click handler to navigate to this person
    personEl.addEventListener('click', () => {
      this.navigateToPerson(person);
    });
    
    container.appendChild(personEl);
  }

  renderPersonWithDirectChildren(person, container) {
    const wrapper = document.createElement('div');
    wrapper.className = 'fam-tree-person-wrapper';
    
    // Render person card (already includes descendant count)
    this.renderPersonCard(person, wrapper);
    
    // Render direct children only
    if (person.children.length > 0) {
      const childrenEl = document.createElement('div');
      childrenEl.className = 'fam-tree-children';
      
      // Render only direct children
      person.children.forEach((child) => {
        this.renderPersonCard(child, childrenEl);
      });
      
      wrapper.appendChild(childrenEl);
    }
    
    container.appendChild(wrapper);
  }

  updateBreadcrumb() {
    const breadcrumbEl = this.container.querySelector('.fam-tree-breadcrumb');
    if (!breadcrumbEl) return;
    
    // Build path from root to current
    const path = [];
    const visited = new Set();
    let current = this.currentRoot;
    
    // Traverse up to root, avoiding cycles
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      path.unshift(current);
      if (current.parentId && current.parentId !== '0' && current.parentId !== '') {
        const parent = this.persons.get(current.parentId);
        if (parent) {
          current = parent;
        } else {
          break;
        }
      } else {
        break;
      }
    }
    
    // If we didn't reach the root, add it
    if (path.length === 0 || path[0].id !== this.rootPerson.id) {
      path.unshift(this.rootPerson);
    }
    
    breadcrumbEl.innerHTML = '';
    
    if (path.length === 0) return;
    
    path.forEach((person, index) => {
      const item = document.createElement('span');
      item.className = 'fam-tree-breadcrumb-item';
      if (index === path.length - 1) {
        item.classList.add('active');
        item.textContent = person.name;
      } else {
        item.textContent = person.name;
        item.style.cursor = 'pointer';
        item.addEventListener('click', () => {
          this.navigateToPerson(person);
        });
      }
      breadcrumbEl.appendChild(item);
    });
  }

  renderPerson(person, container, generation) {
    const wrapper = document.createElement('div');
    wrapper.className = 'fam-tree-person-wrapper';
    
    const personEl = document.createElement('div');
    personEl.className = 'fam-tree-person';
    if (person.children.length > 0) {
      personEl.classList.add('has-children');
    }
    
    // Person name
    const nameEl = document.createElement('div');
    nameEl.className = 'fam-tree-person-name';
    nameEl.textContent = person.name;
    personEl.appendChild(nameEl);
    
    // Birth and death dates below name
    const birthEvent = person.events.find(e => e.type === 'Geburt');
    const deathEvent = person.events.find(e => e.type === 'Tod');
    const birthDate = birthEvent?.date || '';
    const deathDate = deathEvent?.date || '';
    
    if (birthDate || deathDate) {
      const datesEl = document.createElement('div');
      datesEl.className = 'fam-tree-person-dates';
      const parts = [];
      if (birthDate) {
        parts.push(`* ${birthDate}`);
      }
      if (deathDate) {
        parts.push(`† ${deathDate}`);
      }
      datesEl.textContent = `(${parts.join(' - ')})`;
      personEl.appendChild(datesEl);
    }
    
    // Events
    const eventsEl = document.createElement('div');
    eventsEl.className = 'fam-tree-person-events';
    
    // Get unique events (group by type and date)
    const uniqueEvents = this.getUniqueEvents(person.events);
    
    // Filter out birth and death events (already shown below name)
    const filteredEvents = uniqueEvents.filter(e => e.type !== 'Geburt' && e.type !== 'Tod');
    
    // Separate marriages from other events
    const marriages = filteredEvents.filter(e => e.type === 'Heirat');
    const otherEvents = filteredEvents.filter(e => e.type !== 'Heirat');
    
    // Sort marriages by date (chronological order)
    marriages.sort((a, b) => {
      const dateA = a.date || '';
      const dateB = b.date || '';
      // Extract year for comparison
      const yearA = parseInt(dateA) || 0;
      const yearB = parseInt(dateB) || 0;
      if (yearA !== yearB) return yearA - yearB;
      // If years are same, compare full dates
      return dateA.localeCompare(dateB);
    });
    
    // Display all marriages, each on a separate line
    marriages.forEach((marriage, index) => {
      const marriageEl = document.createElement('div');
      marriageEl.className = 'fam-tree-event';
      
      const parts = [`H${index + 1}:`];
      if (marriage.date) {
        parts.push(marriage.date);
      }
      if (marriage.partner) {
        parts.push(marriage.partner);
      }
      if (marriage.partnerBirthDeath) {
        parts.push(marriage.partnerBirthDeath);
      }
      
      marriageEl.textContent = parts.join(' ');
      eventsEl.appendChild(marriageEl);
    });
    
    // Display other events (Scheidung, etc.)
    otherEvents.forEach(event => {
      const eventEl = document.createElement('div');
      eventEl.className = 'fam-tree-event';
      
      const typeEl = document.createElement('span');
      typeEl.className = 'fam-tree-event-type';
      typeEl.textContent = event.type + ':';
      
      const dateEl = document.createElement('span');
      dateEl.className = 'fam-tree-event-date';
      dateEl.textContent = event.date || 'unbekannt';
      
      eventEl.appendChild(typeEl);
      eventEl.appendChild(dateEl);
      
      eventsEl.appendChild(eventEl);
    });
    
    personEl.appendChild(eventsEl);
    
    // Add click handler to navigate to this person
    personEl.addEventListener('click', () => {
      this.navigateToPerson(person);
    });
    
    wrapper.appendChild(personEl);
    
    // Show descendant count
    const descendantCount = this.countDescendants(person);
    if (descendantCount > 0) {
      const countEl = document.createElement('div');
      countEl.className = 'fam-tree-descendant-count';
      countEl.textContent = `${descendantCount} descendant${descendantCount !== 1 ? 's' : ''}`;
      personEl.appendChild(countEl);
    }
    
    // Children - always show them
    if (person.children.length > 0) {
      const childrenEl = document.createElement('div');
      childrenEl.className = 'fam-tree-children';
      
      // Render all children
      person.children.forEach((child) => {
        this.renderPerson(child, childrenEl, generation + 1, false);
      });
      
      wrapper.appendChild(childrenEl);
    }
    
    container.appendChild(wrapper);
  }

  getUniqueEvents(events) {
    const eventMap = new Map();
    
    events.forEach(event => {
      const key = `${event.type}_${event.date || ''}_${event.partner || ''}`;
      if (!eventMap.has(key)) {
        eventMap.set(key, {
          type: event.type,
          date: event.date || '',
          partner: event.partner || '',
          partnerBirthDeath: event.partnerBirthDeath || ''
        });
      } else {
        // Merge partner info if multiple marriages with same date
        const existing = eventMap.get(key);
        if (event.partner && !existing.partner.includes(event.partner)) {
          existing.partner = existing.partner ? `${existing.partner}, ${event.partner}` : event.partner;
        }
      }
    });
    
    return Array.from(eventMap.values());
  }

  countDescendants(person) {
    let count = person.children.length;
    person.children.forEach(child => {
      count += this.countDescendants(child);
    });
    return count;
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    const containers = document.querySelectorAll('.fam-tree-container');
    containers.forEach(container => {
      new FamilyTree(container);
    });
  });
} else {
  const containers = document.querySelectorAll('.fam-tree-container');
  containers.forEach(container => {
    new FamilyTree(container);
  });
}

export default function decorate(block) {
  // If used as a block decorator
  const container = document.createElement('div');
  container.className = 'fam-tree-container';
  container.innerHTML = `
    <div class="fam-tree-controls">
      <div class="fam-tree-search-wrapper">
        <input type="text" class="fam-tree-search" id="fam-tree-search" placeholder="Suche nach Name...">
        <div class="fam-tree-search-results" id="fam-tree-search-results"></div>
      </div>
    </div>
    <div class="fam-tree-breadcrumb"></div>
    <div class="fam-tree-loading">Loading family tree...</div>
    <div class="fam-tree-error" style="display: none;"></div>
    <div class="fam-tree-wrapper"></div>
  `;
  block.textContent = '';
  block.appendChild(container);
  new FamilyTree(container);
}
