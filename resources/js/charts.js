/**
 *    ______      ___
 *   / ____/___  /   | _____________  __________
 *  / / __/ __ \/ /| |/ ___/ ___/ _ \/ ___/ ___/
 * / /_/ / /_/ / ___ / /__/ /__/  __(__  |__  )
 * \____/\____/_/  |_\___/\___/\___/____/____/
 *
 * The MIT License (MIT)
 * Copyright (c) 2009-2018 Gerardo Orellana <hello @ goaccess.io>
 */

'use strict';

// This is faster than calculating the exact length of each label.
// e.g., getComputedTextLength(), slice()...
function truncate(text, width) {
	text.each(function () {
		var parent = this.parentNode, $d3parent = d3.select(parent);
		var gw = $d3parent.node().getBBox();
		var x = (Math.min(gw.width, width) / 2) * -1;
		// adjust wrapper <svg> width
		if ('svg' == parent.nodeName) {
			$d3parent.attr('width', width).attr('x', x);
		}
		// wrap <text> within an svg
		else {
			$d3parent.insert('svg', function () {
				return this;
			}.bind(this))
			.attr('class', 'wrap-text')
			.attr('width', width)
			.attr('x', x)
			.append(function () {
				return this;
			}.bind(this));
		}
	});
}

function WorldMap(selection) {
	const maxLat = 84;
	let path = null;
	let projection = null;
	let tlast = [0, 0];
	let slast = null;
	let opts = {};
	let metric = 'hits';
	let margin = {
		top: 20,
		right: 50,
		bottom: 40,
		left: 50
	};
	let width = 760;
	let height = 170;
	// default value; will be set externally
	let projectionType = 'mercator';
	let initialScale;

	function innerW() {
		return width - margin.left - margin.right;
	}

	function innerH() {
		return height - margin.top - margin.bottom;
	}

	function mapData(data) {
		return data.reduce((countryData, region) => {
			if (!region.items) countryData.push(region);
			else region.items.forEach(item => countryData.push({
				data: item.data,
				hits: item.hits.count,
				visitors: item.visitors.count,
				bytes: item.bytes.count,
				region: region.data
			}));
			return countryData;
		}, []);
	}

	function formatTooltip(data) {
		const d = {
			...data
		};
		let out = {};
		out[0] = GoAccess.Util.fmtValue(d['data'], 'str');
		out[1] = metric === 'bytes' ? GoAccess.Util.fmtValue(d['bytes'], 'bytes') : d3.format(',')(d['hits']);
		if (metric === 'hits') out[2] = d3.format(',')(d['visitors']);
		const template = d3.select('#tpl-chart-tooltip')
			.html();
		return Hogan.compile(template)
			.render({
				'data': out
			});
	}

	function mouseover(event, selection, data) {
		const tooltip = selection.select('.chart-tooltip-wrap');
		tooltip.html(formatTooltip(data))
			.style('left', `${d3.pointer(event)[0] + 10}px`)
			.style('top', `${d3.pointer(event)[1] + 10}px`)
			.style('display', 'block');
	}

	function mouseout(selection) {
		const tooltip = selection.select('.chart-tooltip-wrap');
		tooltip.style('display', 'none');
	}

	function drawLegend(selection, colorScale) {
		const legendHeight = 10;
		const legendPadding = 10;
		let svg = selection.select('.legend-svg');
		if (svg.empty()) {
			svg = selection.append('svg')
				.attr('class', 'legend-svg')
				.attr('width', width + margin.left + margin.right)
				.attr('height', legendHeight + 2 * legendPadding);
		}
		let legend = svg.select('.legend');
		if (legend.empty()) {
			legend = svg.append('g')
				.attr('class', 'legend')
				.attr('transform', `translate(${margin.left}, ${legendPadding})`);
		}
		const legendData = colorScale.quantiles();
		const legendRects = legend.selectAll('rect')
			.data(legendData);
		legendRects.enter()
			.append('rect')
			.merge(legendRects)
			.attr('x', (d, i) => (i * (innerW())) / legendData.length)
			.attr('y', 0)
			.attr('width', innerW() / legendData.length)
			.attr('height', legendHeight)
			.style('fill', d => colorScale(d));
		legendRects.exit()
			.remove();
		const legendTexts = legend.selectAll('text')
			.data(legendData);
		legendTexts.enter()
			.append('text')
			.merge(legendTexts)
			.attr('x', (d, i) => (i * (innerW())) / legendData.length)
			.attr('y', legendHeight + legendPadding)
			.style('font-size', '10px')
			.attr('text-anchor', 'middle')
			.text(d => metric === 'bytes' ? GoAccess.Util.fmtValue(d, 'bytes') : d3.format(',')(d));
		legendTexts.exit()
			.remove();
	}

	function updateSphere(svg, g) {
		if (projectionType === 'orthographic') {
			let sphere = g.selectAll('.sphere')
				.data([{
					type: 'Sphere'
				}]);
			// Insert as first child to be behind countries
			let sphereEnter = sphere.enter()
				.insert('path', ':first-child')
				.attr('class', 'sphere')
				.attr('d', path)
				.attr('fill', '#DDEEFF') /* Light blue for ocean */
				.attr('opacity', 0);
			sphere = sphereEnter.merge(sphere);
			sphere.transition()
				.duration(500)
				.attr('opacity', 1);
		} else {
			// Remove sphere when not in orthographic projection
			g.selectAll('.sphere')
				.transition()
				.duration(500)
				.attr('opacity', 0)
				.remove();
		}
	}

	function updateMap(selection, svg, data, countries, countryNameToGeoJson) {
		data = mapData(data);
		path = d3.geoPath()
			.projection(projection);

		const colorScale = d3.scaleQuantile()
			.domain(data.map(d => d[metric]))
			.range(['#eafff1', '#a7e3d7', '#6cc5c0', '#44a2b1', '#246e96']);

		if (data.length)
			drawLegend(selection, colorScale);

		// Create a mapping from country name to data
		const dataByName = {};
		data.forEach(d => {
			const k = d.data.split(' ')[0];
			dataByName[k] = d;
		});

		// Add graticule (grid lines)
		if (projectionType !== 'mercator') {
			const graticule = d3.geoGraticule();
			let grid = svg.select('g')
				.selectAll('.graticule')
				.data([graticule()]);
			let gridEnter = grid.enter()
				.append('path')
				.attr('class', 'graticule')
				.attr('d', path)
				.attr('fill', 'none')
				.attr('stroke', '#ccc')
				.attr('stroke-width', 0.5)
				.attr('stroke-dasharray', '3,3')
				.attr('opacity', 0);
			grid = gridEnter.merge(grid);
			grid.transition()
				.duration(500)
				.attr('opacity', 0.4);
		}

		let country = svg.select('g')
			.selectAll('.country')
			.data(countries);
		let countryEnter = country.enter()
			.append('path')
			.attr('class', 'country')
			.attr('d', path)
			.attr('opacity', 0);
		country = countryEnter.merge(country)
			.on('mouseover', function(event, d) {
				const countryData = dataByName[d.id];
				if (countryData) mouseover(event, selection, countryData);
			})
			.on('mouseout', function() {
				mouseout(selection);
			});
		country.transition()
			.duration(500)
			.style('fill', function(d) {
				const countryData = dataByName[d.id];
				return countryData ? colorScale(countryData[metric]) : '#cccccc54';
			})
			.attr('opacity', 1);
		country.exit()
			.transition()
			.duration(500)
			.attr('opacity', 0)
			.remove();
	}

	function setBounds(projection, maxLat) {
		// Top-left corner of the “viewable” lat
		const [yaw] = projection.rotate();
		const xymax = projection([-yaw + 180 - 1e-6, -maxLat]);
		const xymin = projection([-yaw - 180 + 1e-6, maxLat]);
		return [xymin, xymax];
	}

	function clampVertical(projection, maxLat, height) {
		const b = setBounds(projection, maxLat);
		// top-left
		const [xMin, yMin] = b[0];
		// bottom-right
		const [xMax, yMax] = b[1];
		const t = projection.translate();
		// If the top (yMin) is now below 0, shift upward.
		if (yMin > 0)
			t[1] -= yMin;
		// If the bottom (yMax) is now above the container height, shift downward.
		else if (yMax < height)
			t[1] += (height - yMax);
		projection.translate(t);
	}

	function baseScale() {
		// If the effective width is small, use a fixed mobile scale; otherwise use the computed scale.
		return innerW() < 400 ? 150 : innerW() / (2 * Math.PI);
	}

	function setProjection(type) {
		if (type === 'mercator') {
			const bScale = baseScale();
			projection = d3.geoMercator()
				.center([0, 15])
				.scale(bScale)
				.translate([innerW() / 2, height / 1.5]);
		} else if (type === 'orthographic') {
			const globeScale = Math.min(innerW(), height) / 1.5;
			projection = d3.geoOrthographic()
				.scale(globeScale)
				.translate([innerW() / 2, height / 2])
				.rotate([0, 0, 0]);
		}
		initialScale = projection.scale();
		path = d3.geoPath().projection(projection);
	}

	function zoomed(event, projection, path, scaleExtent, g) {
		const scale = event.transform.k;
		if (projectionType === 'mercator') {
			const containerCenter = [innerW() / 2, height / 2];
			let anchor = containerCenter;
			if (Math.abs(scale - slast) > 1e-3) {
				const geoCoord = projection.invert(anchor);
				// Use baseScale() here instead of innerW()/(2*Math.PI)
				projection.scale(scale * baseScale());
				const newPixel = projection(geoCoord);
				const dxAnchor = anchor[0] - newPixel[0];
				const dyAnchor = anchor[1] - newPixel[1];
				const t = projection.translate();
				projection.translate([t[0] + dxAnchor, t[1] + dyAnchor]);
				clampVertical(projection, maxLat, height);
			} else {
				const newX = event.transform.x;
				const newY = event.transform.y;
				const dx = newX - tlast[0];
				const dy = newY - tlast[1];
				let [longitude] = projection.rotate();
				longitude += 360 * (dx / width) * (scaleExtent[0] / scale);
				projection.rotate([longitude, 0, 0]);
				const t = projection.translate();
				t[1] += dy;
				projection.translate(t);
				clampVertical(projection, maxLat, height);
			}
		}
		else if (projectionType === 'orthographic') {
			// Use the zoom transform’s k to compute a new scale,
			// clamping to a maximum factor (here, 2× the initialScale).
			let newScale = scale * initialScale;
			const maxOrthoScale = initialScale * 2;
			if (newScale > maxOrthoScale) newScale = maxOrthoScale;
			if (newScale < initialScale) newScale = initialScale;
			projection.scale(newScale);

			// Update rotation using the difference between the current and previous transform values.
			const dx = event.transform.x - tlast[0];
			const dy = event.transform.y - tlast[1];
			let [longitude, latitude] = projection.rotate();

			// we could reduce sensitivity for smoother rotation
			const sensitivity = 0.2;
			longitude += dx * sensitivity;
			latitude -= dy * sensitivity;
			latitude = Math.max(-90, Math.min(90, latitude));
			projection.rotate([longitude, latitude, 0]);
		}
		g.selectAll('path')
			.attr('d', path);
		tlast = [event.transform.x, event.transform.y];
		slast = scale;
	}

	function createSVG(selectionElem) {
		const svg = d3.select(selectionElem)
			.append('svg')
			.attr('class', 'map')
			.attr('style', 'display:block; margin:auto;')
			.attr('width', innerW())
			.attr('height', height)
			.lower();
		const g = svg.append('g')
			.attr('transform', 'translate(0,0)');

		// Use the externally provided projectionType
		setProjection(projectionType);
		// Compute scale extent based on projection type.
		let scaleExtent;
		if (projectionType === 'mercator') {
			// For cellphones (narrow screens), use a fixed scale and limit zoom-out to the initial state.
			if (innerW() < 400) {
				// Here 1 means the initial zoom level (no zoom-out), 6 is arbitrary for max zoom in.
				scaleExtent = [1, 6];
			} else {
				// Otherwise, calculate the base scale from the bounds.
				const bounds = setBounds(projection, maxLat);
				const s = innerW() / (bounds[1][0] - bounds[0][0]);
				scaleExtent = [s, 6 * s];
			}
		} else if (projectionType === 'orthographic') {
			// For orthographic, let d3.zoom use a relative scale factor.
			// The identity transform (k = 1) corresponds to the initialScale,
			// and we allow zooming from 1x to 2x.
			scaleExtent = [1, 2];
		}
		const zoom = d3.zoom()
			.scaleExtent(scaleExtent)
			.on('zoom', event => {
				zoomed(event, projection, path, scaleExtent, g);
			});
		svg.call(zoom);
		return {
			svg,
			g
		};
	}

	function chart(selectionData) {
		selectionData.each(function(data) {
			const worldData = window.countries110m;
			const countries = topojson.feature(worldData, worldData.objects.countries)
				.features; /* Build a mapping from country names to GeoJSON if needed */
			const countryNameToGeoJson = {};
			countries.forEach(country => {
				countryNameToGeoJson[country.properties.name] = country;
			});
			let svgObj = d3.select(this)
				.select('svg.map');
			let g;
			if (svgObj.empty()) {
				const created = createSVG(this);
				svgObj = created.svg;
				g = created.g;
			} else {
				/* If the SVG already exists, select its group */
				g = svgObj.select('g');
			}
			updateMap(d3.select(this), svgObj, data, countries, countryNameToGeoJson); /* Update sphere in case the projection is orthographic */
			updateSphere(svgObj, g);
		});
	}
	// Getter-setter for metric
	chart.metric = function(_) {
		if (!arguments.length) return metric;
		metric = _;
		return chart;
	};
	// Getter-setter for opts
	chart.opts = function(_) {
		if (!arguments.length) return opts;
		opts = _;
		return chart;
	};
	// Getter-setter for width
	chart.width = function(_) {
		if (!arguments.length) return width;
		width = _;
		return chart;
	};
	// Getter-setter for height
	chart.height = function(_) {
		if (!arguments.length) return height;
		height = _;
		return chart;
	};
	// Getter-setter for projectionType
	chart.projectionType = function(_) {
		if (!arguments.length) return projectionType;
		projectionType = _;
		return chart;
	};

	return chart;
}

function AreaChart(dualYaxis) {
	var opts = {};
	var margin = {
			top    : 20,
			right  : 50,
			bottom : 40,
			left   : 50,
		},
		height = 170,
		nTicks = 10,
		padding = 10,
		width = 760;
	var labels = { x: 'Unnamed', y0: 'Unnamed', y1: 'Unnamed' };
	var format = { x: null, y0: null, y1: null};

	var xValue = function (d) {
			return d[0];
		},
		yValue0 = function (d) {
			return d[1];
		},
		yValue1 = function (d) {
			return d[2];
		};

	var xScale = d3.scaleBand();
	var yScale0 = d3.scaleLinear().nice();
	var yScale1 = d3.scaleLinear().nice();

	var xAxis = d3.axisBottom(xScale)
		.tickFormat(function(d) {
			if (format.x)
				return GoAccess.Util.fmtValue(d, format.x);
			return d;
		});

	var yAxis0 = d3.axisLeft(yScale0)
		.tickFormat(function(d) {
			return d3.format('.2s')(d);
		});

	var yAxis1 = d3.axisRight(yScale1)
		.tickFormat(function(d) {
			if (format.y1)
				return GoAccess.Util.fmtValue(d, format.y1);
			return d3.format('.2s')(d);
		});

	var xGrid = d3.axisBottom(xScale);
	var yGrid = d3.axisLeft(yScale0);

	var area0 = d3.area()
		.curve(d3.curveMonotoneX)
		.x(X)
		.y0(height)
		.y1(Y0);

	var area1 = d3.area()
		.curve(d3.curveMonotoneX)
		.x(X)
		.y0(Y1)
		.y1(height);

	var line0 = d3.line()
		.curve(d3.curveMonotoneX)
		.x(X)
		.y(Y0);

	var line1 = d3.line()
		.curve(d3.curveMonotoneX)
		.x(X)
		.y(Y1);

	// The x-accessor for the path generator; xScale ∘ xValue.
	function X(d) {
		return (xScale(d[0]) + xScale.bandwidth() / 2);
	}

	// The x-accessor for the path generator; yScale0 yValue0.
	function Y0(d) {
		return yScale0(d[1]);
	}

	// The x-accessor for the path generator; yScale0 yValue0.
	function Y1(d) {
		return yScale1(d[2]);
	}

	function innerW() {
		return width - margin.left - margin.right;
	}

	function innerH() {
		return height - margin.top - margin.bottom;
	}

	function getXTicks(data) {
		const domain = xScale.domain();
		if (data.length < nTicks)
			return domain;

		return d3.range(0, nTicks).map(function(i) {
			const index = Math.floor(i * (domain.length - 1) / (nTicks - 1));
			if (index >= 0 && index < domain.length)
				return domain[index];
			return null;
		});
	}

	function getYTicks(scale) {
		var domain = scale.domain();
		return d3.range(domain[0], domain[1], Math.ceil(domain[1] / nTicks));
	}

	// Convert data to standard representation greedily;
	// this is needed for nondeterministic accessors.
	function mapData(data) {
		var _datum = function (d, i) {
			var datum = [xValue.call(data, d, i), yValue0.call(data, d, i)];
			dualYaxis && datum.push(yValue1.call(data, d, i));
			return datum;
		};
		return data.map(function (d, i) {
			return _datum(d, i);
		});
	}

	function updateScales(data) {
		// Update the x-scale.
		xScale.domain(data.map(function (d) {
			return d[0];
		}))
		.range([0, innerW()]);

		// Update the y-scale.
		yScale0.domain([0, d3.max(data, function (d) {
			return d[1];
		})])
		.range([innerH(), 0]);

		// Update the y-scale.
		dualYaxis && yScale1.domain([0, d3.max(data, function (d) {
			return d[2];
		})])
		.range([innerH(), 0]);
	}

	function toggleOpacity(ele, op) {
		d3.select(ele.parentNode).selectAll('.' + (ele.getAttribute('data-yaxis') == 'y0' ? 'y1' : 'y0')).attr('style', op);
	}

	function setLegendLabels(svg) {
		// Legend Color
		var rect = svg.selectAll('rect.legend.y0').data([null]);

		var rectEnter = rect.enter()
			.append('rect')
			.attr('class', 'legend y0')
			.attr('data-yaxis', 'y0')
			.on('mousemove', function(d, i) {
				toggleOpacity(this, 'opacity:0.1');
			})
			.on('mouseleave', function(d, i) {
				toggleOpacity(this, null);
			})
			.attr('y', (height - 15));

		rectEnter.merge(rect)
			.attr('x', (width / 2) - 100);

		// Legend Labels
		var text = svg.selectAll('text.legend.y0').data([null]);

		var textEnter = text.enter()
			.append('text')
			.attr('class', 'legend y0')
			.attr('data-yaxis', 'y0')
			.on('mousemove', function(d, i) {
				toggleOpacity(this, 'opacity:0.1');
			})
			.on('mouseleave', function(d, i) {
				toggleOpacity(this, null);
			})
			.attr('y', (height - 6));

		textEnter.merge(text)
			.attr('x', (width / 2) - 85)
			.text(labels.y0);

		if (!dualYaxis)
			return;

		// Legend Labels
		rect = svg.selectAll('rect.legend.y1').data([null]);

		var rectEnter = rect.enter()
			.append('rect')
			.attr('class', 'legend y1')
			.attr('data-yaxis', 'y1')
			.on('mousemove', function(d, i) {
				toggleOpacity(this, 'opacity:0.1');
			})
			.on('mouseleave', function(d, i) {
				toggleOpacity(this, null);
			})
			.attr('y', (height - 15));

		rectEnter.merge(rect)
			.attr('x', (width / 2));

		// Legend Labels
		text = svg.selectAll('text.legend.y1').data([null]);

		var textEnter = text.enter()
			.append('text')
			.attr('class', 'legend y1')
			.attr('data-yaxis', 'y1')
			.on('mousemove', function(d, i) {
				toggleOpacity(this, 'opacity:0.1');
			})
			.on('mouseleave', function(d, i) {
				toggleOpacity(this, null);
			})
			.attr('y', (height - 6));

		textEnter.merge(text)
			.attr('x', (width / 2) + 15)
			.text(labels.y1);
	}

	function setAxisLabels(svg) {
		// Labels
		svg.selectAll('text.axis-label.y0')
			.data([null])
			.enter()
			.append('text')
			.attr('class', 'axis-label y0')
			.attr('y', 10)
			.attr('x', 53)
			.text(labels.y0);

		if (!dualYaxis) return;

		// Labels
		var tEnter = svg.selectAll('text.axis-label.y1')
			.data([null])
			.enter()
			.append('text')
			.attr('class', 'axis-label y1')
			.attr('y', 10)
			.text(labels.y1);

		dualYaxis && tEnter.attr('x', width - 25);
	}

	function createSkeleton(svg) {
		const g = svg.append('g');

		// Lines
		g.append('g')
			.attr('class', 'line line0 y0');
		dualYaxis && g.append('g')
			.attr('class', 'line line1 y1');

		// Areas
		g.append('g')
			.attr('class', 'area area0 y0');
		dualYaxis && g.append('g')
			.attr('class', 'area area1 y1');

		// Points
		g.append('g')
			.attr('class', 'points y0');
		dualYaxis && g.append('g')
			.attr('class', 'points y1');

		// Grid
		g.append('g')
			.attr('class', 'x grid');
		g.append('g')
			.attr('class', 'y grid');

		// Axis
		g.append('g')
			.attr('class', 'x axis');
		g.append('g')
			.attr('class', 'y0 axis');
		dualYaxis && g.append('g')
			.attr('class', 'y1 axis');

		// Rects
		g.append('g')
			.attr('class', 'rects');

		setAxisLabels(svg);
		setLegendLabels(svg);

		// Mouseover line
		g.append('line')
			.attr('y2', innerH())
			.attr('y1', 0)
			.attr('class', 'indicator');
	}

	function pathLen(d) {
		return d.node().getTotalLength();
	}

	function addLine(g, data, line, cName) {
		// Update the line path.
		var path = g.select('g.' + cName).selectAll('path.' + cName).data([data]);

		// enter
		var pathEnter = path.enter()
			.append('svg:path')
			.attr('d', line)
			.attr('class', cName)
			.attr('stroke-dasharray', function(d) {
				var pl = pathLen(d3.select(this));
				return pl + ' ' + pl;
			})
			.attr('stroke-dashoffset', function(d) {
				return pathLen(d3.select(this));
			});

		// update
		pathEnter.merge(path)
			.attr('d', line)
			.transition()
			.attr('stroke-dasharray', function(d) {
			var pl = pathLen(d3.select(this));
				return pl + ' ' + pl;
			})
			.duration(2000)
			.attr('stroke-dashoffset', 0);

		// remove elements
		path.exit().remove();

	}

	function addArea(g, data, cb, cName) {
		// Update the area path.
		var area = g.select('g.' + cName).selectAll('path.' + cName)
			.data([data]);

		var areaEnter = area.enter()
			.append('svg:path')
			.attr('class', cName);

		areaEnter.merge(area)
			.attr('d', cb);

		// remove elements
		area.exit().remove();
	}

	// Update the area path and lines.
	function addAreaLines(g, data) {
		// Update the area path.
		addArea(g, data, area0.y0(yScale0.range()[0]), 'area0');
		// Update the line path.
		addLine(g, data, line0, 'line0');
		// Update the area path.
		addArea(g, data, area1.y1(yScale1.range()[0]), 'area1');
		// Update the line path.
		addLine(g, data, line1, 'line1');
	}

	// Update chart points
	function addPoints(g, data) {
		var radius = data.length > 100 ? 1 : 2.5;

		var points = g.select('g.points.y0').selectAll('circle.point').data(data);

		var pointsEnter = points.enter()
			.append('svg:circle')
			.attr('r', radius)
			.attr('class', 'point');

		pointsEnter.merge(points)
			.attr('cx', function(d) {
				return (xScale(d[0]) + xScale.bandwidth() / 2);
			})
			.attr('cy', function(d) {
				return yScale0(d[1]);
			});

		// remove elements
		points.exit().remove();

		if (!dualYaxis)
			return;

		points = g.select('g.points.y1').selectAll('circle.point').data(data);

		pointsEnter = points.enter()
			.append('svg:circle')
			.attr('r', radius)
			.attr('class', 'point');

		pointsEnter.merge(points)
			.attr('cx', function(d) {
				return (xScale(d[0]) + xScale.bandwidth() / 2);
			})
			.attr('cy', function(d) {
				return yScale1(d[2]);
			});

		// remove elements
		points.exit().remove();
	}

	function addAxis(g, data) {
		var xTicks = getXTicks(data);
		var tickDistance = xTicks.length > 1 ? (xScale(xTicks[1]) - xScale(xTicks[0])) : innerW();
		var labelW = tickDistance - padding;

		// Update the x-axis.
		g.select('.x.axis')
			.attr('transform', 'translate(0,' + yScale0.range()[0] + ')')
			.call(xAxis.tickValues(xTicks))
			.selectAll(".tick text")
			.call(truncate, labelW > 0 ? labelW : innerW());

		// Update the y0-axis.
		g.select('.y0.axis')
			.call(yAxis0.tickValues(getYTicks(yScale0)));

		if (!dualYaxis)
			return;

		// Update the y1-axis.
		g.select('.y1.axis')
			.attr('transform', 'translate(' + innerW() + ', 0)')
			.call(yAxis1.tickValues(getYTicks(yScale1)));
	}

	// Update the X-Y grid.
	function addGrid(g, data) {
		g.select('.x.grid')
			.attr('transform', 'translate(0,' + yScale0.range()[0] + ')')
			.call(xGrid
				.tickValues(getXTicks(data))
				.tickSize(-innerH(), 0, 0)
				.tickSizeOuter(0)
				.tickFormat('')
			);

		g.select('.y.grid')
			.call(yGrid
				.tickValues(getYTicks(yScale0))
				.tickSize(-innerW(), 0)
				.tickSizeOuter(0)
				.tickFormat('')
			);
	}

	function formatTooltip(data) {
		var d = data.slice(0);

		d[0] = (format.x) ? GoAccess.Util.fmtValue(d[0], format.x) : d[0];
		d[1] = (format.y0) ? GoAccess.Util.fmtValue(d[1], format.y0) : d3.format(',')(d[1]);
		dualYaxis && (d[2] = (format.y1) ? GoAccess.Util.fmtValue(d[2], format.y1) : d3.format(',')(d[2]));

		var template = d3.select('#tpl-chart-tooltip').html();
		return Hogan.compile(template).render({
			'data': d
		});
	}

	function mouseover(event, selection, data) {
		var tooltip = selection.select('.chart-tooltip-wrap');
		tooltip.html(formatTooltip(data))
			.style('left', X(data) + 'px')
			.style('top',  (d3.pointer(event)[1] + 10) + 'px')
			.style('display', 'block');

		selection.select('line.indicator')
			.style('display', 'block')
			.attr('transform', 'translate(' + X(data) + ',' + 0 + ')');
	}

	function mouseout(selection, g) {
		var tooltip = selection.select('.chart-tooltip-wrap');
		tooltip.style('display', 'none');

		g.select('line.indicator').style('display', 'none');
	}

	function addRects(selection, g, data) {
		var w = (innerW() / data.length);

		var rects = g.select('g.rects').selectAll('rect').data(data);

		var rectsEnter = rects.enter()
			.append('svg:rect')
			.attr('height', innerH())
			.attr('class', 'point');

		rectsEnter.merge(rects)
			.attr('width', w)
			.attr('x', function(d, i) {
				return (w * i);
			})
			.attr('y', 0)
			.on('mousemove', function(event) {
				mouseover(event, selection, d3.select(this).datum());
			})
			.on('mouseleave', function(event) {
				mouseout(selection, g);
			});

		// remove elements
		rects.exit().remove();
	}

	function chart(selection) {
		selection.each(function (data) {
			// normalize data
			data = mapData(data);
			// updates X-Y scales
			updateScales(data);

			// select the SVG element, if it exists
			let svg = d3.select(this).select('svg');

			// if the SVG element doesn't exist, create it
			if (svg.empty()) {
				svg = d3.select(this).append('svg').attr('width', width).attr('height', height);
				createSkeleton(svg);
			}

			// Update the inner dimensions.
			var g = svg.select('g')
				.attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

			// Add grid
			addGrid(g, data);
			// Add chart lines and areas
			addAreaLines(g, data);
			// Add chart points
			addPoints(g, data);
			// Add axis
			addAxis(g, data);
			// Add rects
			addRects(selection, g, data);
		});
	}

	chart.opts = function (_) {
		if (!arguments.length) return opts;
		opts = _;
		return chart;
	};

	chart.format = function (_) {
		if (!arguments.length) return format;
		format = _;
		return chart;
	};

	chart.labels = function (_) {
		if (!arguments.length) return labels;
		labels = _;
		return chart;
	};

	chart.margin = function (_) {
		if (!arguments.length) return margin;
		margin = _;
		return chart;
	};

	chart.width = function (_) {
		if (!arguments.length) return width;
		width = _;
		return chart;
	};

	chart.height = function (_) {
		if (!arguments.length) return height;
		height = _;
		return chart;
	};

	chart.x = function (_) {
		if (!arguments.length) return xValue;
		xValue = _;
		return chart;
	};

	chart.y0 = function (_) {
		if (!arguments.length) return yValue0;
		yValue0 = _;
		return chart;
	};

	chart.y1 = function (_) {
		if (!arguments.length) return yValue1;
		yValue1 = _;
		return chart;
	};

	return chart;
}

function BarChart(dualYaxis) {
	var opts = {};
	var margin = {
			top    : 20,
			right  : 50,
			bottom : 40,
			left   : 50,
		},
		height = 170,
		nTicks = 10,
		padding = 10,
		width = 760;
	var labels = { x: 'Unnamed', y0: 'Unnamed', y1: 'Unnamed' };
	var format = { x: null, y0: null, y1: null};

	var xValue = function (d) {
			return d[0];
		},
		yValue0 = function (d) {
			return d[1];
		},
		yValue1 = function (d) {
			return d[2];
		};

	var xScale = d3.scaleBand()
		.paddingInner(0.1)
		.paddingOuter(0.1);
	var yScale0 = d3.scaleLinear().nice();
	var yScale1 = d3.scaleLinear().nice();

	var xAxis = d3.axisBottom(xScale)
		.tickFormat(function (d) {
			if (format.x)
				return GoAccess.Util.fmtValue(d, format.x);
			return d;
		});

	var yAxis0 = d3.axisLeft(yScale0)
		.tickFormat(function (d) {
			return d3.format('.2s')(d);
		});

	var yAxis1 = d3.axisRight(yScale1)
		.tickFormat(function (d) {
			if (format.y1)
				return GoAccess.Util.fmtValue(d, format.y1);
			return d3.format('.2s')(d);
		});

	var xGrid = d3.axisBottom(xScale);
	var yGrid = d3.axisLeft(yScale0);

	function innerW() {
		return width - margin.left - margin.right;
	}

	function innerH() {
		return height - margin.top - margin.bottom;
	}

	function getXTicks(data) {
		const domain = xScale.domain();
		if (data.length < nTicks)
			return domain;

		return d3.range(0, nTicks).map(function(i) {
			const index = Math.floor(i * (domain.length - 1) / (nTicks - 1));
			if (index >= 0 && index < domain.length)
				return domain[index];
			return null;
		});
	}

	function getYTicks(scale) {
		var domain = scale.domain();
		return d3.range(domain[0], domain[1], Math.ceil(domain[1] / nTicks));
	}

	// The x-accessor for the path generator; xScale ∘ xValue.
	function X(d) {
		return (xScale(d[0]) + xScale.bandwidth() / 2);
	}

	// Convert data to standard representation greedily;
	// this is needed for nondeterministic accessors.
	function mapData(data) {
		var _datum = function (d, i) {
			var datum = [xValue.call(data, d, i), yValue0.call(data, d, i)];
			dualYaxis && datum.push(yValue1.call(data, d, i));
			return datum;
		};
		return data.map(function (d, i) {
			return _datum(d, i);
		});
	}

	function updateScales(data) {
		// Update the x-scale.
		xScale.domain(data.map(function (d) {
			return d[0];
		}))
		.range([0, innerW()]);

		// Update the y-scale.
		yScale0.domain([0, d3.max(data, function (d) {
			return d[1];
		})])
		.range([innerH(), 0]);

		// Update the y-scale.
		// If all values are [0, 0]. This can cause issues when drawing the
		// chart because all values passed to the scale will be mapped to the
		// same value in the range, thus + 0.1 e.g., Not Found visitors.
		dualYaxis && yScale1.domain([0, d3.max(data, function (d) {
			return d[2];
		}) + 0.1])
		.range([innerH(), 0]);
	}

	function toggleOpacity(ele, op) {
		d3.select(ele.parentNode).selectAll('.' + (ele.getAttribute('data-yaxis') == 'y0' ? 'y1' : 'y0')).attr('style', op);
	}

	function setLegendLabels(svg) {
		// Legend Color
		var rect = svg.selectAll('rect.legend.y0').data([null]);

		var rectEnter = rect.enter()
			.append('rect')
			.attr('class', 'legend y0')
			.attr('data-yaxis', 'y0')
			.on('mousemove', function(d, i) {
				toggleOpacity(this, 'opacity:0.1');
			})
			.on('mouseleave', function(d, i) {
				toggleOpacity(this, null);
			})
			.attr('y', (height - 15));

		rectEnter.merge(rect)
			.attr('x', (width / 2) - 100);

		// Legend Labels
		var text = svg.selectAll('text.legend.y0').data([null]);

		var textEnter = text.enter()
			.append('text')
			.attr('class', 'legend y0')
			.attr('data-yaxis', 'y0')
			.on('mousemove', function(d, i) {
				toggleOpacity(this, 'opacity:0.1');
			})
			.on('mouseleave', function(d, i) {
				toggleOpacity(this, null);
			})
			.attr('y', (height - 6));

		textEnter.merge(text)
			.attr('x', (width / 2) - 85)
			.text(labels.y0);

		if (!dualYaxis)
			return;

		// Legend Labels
		rect = svg.selectAll('rect.legend.y1').data([null]);

		var rectEnter = rect.enter()
			.append('rect')
			.attr('class', 'legend y1')
			.attr('data-yaxis', 'y1')
			.on('mousemove', function(d, i) {
				toggleOpacity(this, 'opacity:0.1');
			})
			.on('mouseleave', function(d, i) {
				toggleOpacity(this, null);
			})
			.attr('y', (height - 15));

		rectEnter.merge(rect)
			.attr('x', (width / 2));

		// Legend Labels
		text = svg.selectAll('text.legend.y1').data([null]);

		var textEnter = text.enter()
			.append('text')
			.attr('class', 'legend y1')
			.attr('data-yaxis', 'y1')
			.on('mousemove', function(d, i) {
				toggleOpacity(this, 'opacity:0.1');
			})
			.on('mouseleave', function(d, i) {
				toggleOpacity(this, null);
			})
			.attr('y', (height - 6));

		textEnter.merge(text)
			.attr('x', (width / 2) + 15)
			.text(labels.y1);
	}

	function setAxisLabels(svg) {
		// Labels
		svg.selectAll('text.axis-label.y0')
			.data([null])
			.enter()
			.append('text')
			.attr('class', 'axis-label y0')
			.attr('y', 10)
			.attr('x', 53)
			.text(labels.y0);

		if (!dualYaxis) return;

		// Labels
		var tEnter = svg.selectAll('text.axis-label.y1')
			.data([null])
			.enter()
			.append('text')
			.attr('class', 'axis-label y1')
			.attr('y', 10)
			.text(labels.y1);

		dualYaxis && tEnter.attr('x', width - 25);
	}

	function createSkeleton(svg) {
		const g = svg.append('g');

		// Grid
		g.append('g')
			.attr('class', 'x grid');
		g.append('g')
			.attr('class', 'y grid');

		// Axis
		g.append('g')
			.attr('class', 'x axis');
		g.append('g')
			.attr('class', 'y0 axis');
		dualYaxis && g.append('g')
			.attr('class', 'y1 axis');

		// Bars
		g.append('g')
			.attr('class', 'bars y0');
		dualYaxis && g.append('g')
			.attr('class', 'bars y1');

		// Rects
		g.append('g')
			.attr('class', 'rects');

		setAxisLabels(svg);
		setLegendLabels(svg);

		// Mouseover line
		g.append('line')
			.attr('y2', innerH())
			.attr('y1', 0)
			.attr('class', 'indicator');
	}

	// Update the area path and lines.
	function addBars(g, data) {
		var bars = g.select('g.bars.y0').selectAll('rect.bar').data(data);

		// enter
		var enter = bars.enter()
			.append('svg:rect')
			.attr('class', 'bar')
			.attr('height', 0)
			.attr('width', function (d, i) { return xScale.bandwidth() / 2; })
			.attr('x', function (d, i) { return xScale(d[0]); })
			.attr('y', function (d, i) { return innerH(); });

		// update
		bars.merge(enter)
			.attr('width', xScale.bandwidth() / 2)
			.attr('x', function (d) { return xScale(d[0]); })
			.transition()
			.delay(function (d, i) { return i / data.length * 1000; })
			.duration(500)
			.attr('height', function (d, i) { return innerH() - yScale0(d[1]); })
			.attr('y', function (d, i) { return yScale0(d[1]); });
		// remove elements
		bars.exit().remove();

		if (!dualYaxis)
			return;

		bars = g.select('g.bars.y1').selectAll('rect.bar').data(data);
		// enter
		enter = bars.enter()
			.append('svg:rect')
			.attr('class', 'bar')
			.attr('height', 0)
			.attr('width', function (d, i) { return xScale.bandwidth() / 2; })
			.attr('x', function (d) { return (xScale(d[0]) + xScale.bandwidth() / 2); })
			.attr('y', function (d, i) { return innerH(); });
		// update
		bars.merge(enter)
			.attr('width', xScale.bandwidth() / 2)
			.attr('x', function (d) { return (xScale(d[0]) + xScale.bandwidth() / 2); })
			.transition()
			.delay(function (d, i) { return i / data.length * 1000; })
			.duration(500)
			.attr('height', function (d, i) { return innerH() - yScale1(d[2]); })
			.attr('y', function (d, i) { return yScale1(d[2]); });
		// remove elements
		bars.exit().remove();
	}

	function addAxis(g, data) {
		var xTicks = getXTicks(data);
		var tickDistance = xTicks.length > 1 ? (xScale(xTicks[1]) - xScale(xTicks[0])) : innerW();
		var labelW = tickDistance - padding;

		// Update the x-axis.
		g.select('.x.axis')
			.attr('transform', 'translate(0,' + yScale0.range()[0] + ')')
			.call(xAxis.tickValues(xTicks))
			.selectAll(".tick text")
			.call(truncate, labelW > 0 ? labelW : innerW());

		// Update the y0-axis.
		g.select('.y0.axis')
			.call(yAxis0.tickValues(getYTicks(yScale0)));

		if (!dualYaxis)
			return;

		// Update the y1-axis.
		g.select('.y1.axis')
			.attr('transform', 'translate(' + innerW() + ', 0)')
			.call(yAxis1.tickValues(getYTicks(yScale1)));
	}

	// Update the X-Y grid.
	function addGrid(g, data) {
		g.select('.x.grid')
			.attr('transform', 'translate(0,' + yScale0.range()[0] + ')')
			.call(xGrid
				.tickValues(getXTicks(data))
				.tickSize(-innerH(), 0, 0)
				.tickSizeOuter(0)
				.tickFormat('')
			);

		g.select('.y.grid')
			.call(yGrid
				.tickValues(getYTicks(yScale0))
				.tickSize(-innerW(), 0)
				.tickSizeOuter(0)
				.tickFormat('')
			);
	}

	function formatTooltip(data) {
		var d = data.slice(0);

		d[0] = (format.x) ? GoAccess.Util.fmtValue(d[0], format.x) : d[0];
		d[1] = (format.y0) ? GoAccess.Util.fmtValue(d[1], format.y0) : d3.format(',')(d[1]);
		dualYaxis && (d[2] = (format.y1) ? GoAccess.Util.fmtValue(d[2], format.y1) : d3.format(',')(d[2]));

		var template = d3.select('#tpl-chart-tooltip').html();
		return Hogan.compile(template).render({
			'data': d
		});
	}

	function mouseover(event, selection, data) {
		var tooltip = selection.select('.chart-tooltip-wrap');
		tooltip.html(formatTooltip(data))
			.style('left', X(data) + 'px')
			.style('top',  (d3.pointer(event)[1] + 10) + 'px')
			.style('display', 'block');

		selection.select('line.indicator')
			.style('display', 'block')
			.attr('transform', 'translate(' + X(data) + ',' + 0 + ')');
	}

	function mouseout(selection, g) {
		var tooltip = selection.select('.chart-tooltip-wrap');
		tooltip.style('display', 'none');

		g.select('line.indicator').style('display', 'none');
	}

	function addRects(selection, g, data) {
		var w = (innerW() / data.length);

		var rects = g.select('g.rects').selectAll('rect').data(data);

		var rectsEnter = rects.enter()
			.append('svg:rect')
			.attr('height', innerH())
			.attr('class', 'point');

		rectsEnter.merge(rects)
			.attr('width', w)
			.attr('x', function(d, i) {
				return (w * i);
			})
			.attr('y', 0)
			.on('mousemove', function(event) {
				mouseover(event, selection, d3.select(this).datum());
			})
			.on('mouseleave', function(event) {
				mouseout(selection, g);
			});

		// remove elements
		rects.exit().remove();
	}

	function chart(selection) {
		selection.each(function (data) {
			// normalize data
			data = mapData(data);
			// updates X-Y scales
			updateScales(data);

			// select the SVG element, if it exists
			let svg = d3.select(this).select('svg');

			// if the SVG element doesn't exist, create it
			if (svg.empty()) {
				svg = d3.select(this).append('svg').attr('width', width).attr('height', height);
				createSkeleton(svg);
			}

			// Update the inner dimensions.
			var g = svg.select('g')
				.attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

			// Add grid
			addGrid(g, data);
			// Add axis
			addAxis(g, data);
			// Add chart lines and areas
			addBars(g, data);
			// Add rects
			addRects(selection, g, data);
		});
	}

	chart.opts = function (_) {
		if (!arguments.length) return opts;
		opts = _;
		return chart;
	};

	chart.format = function (_) {
		if (!arguments.length) return format;
		format = _;
		return chart;
	};

	chart.labels = function (_) {
		if (!arguments.length) return labels;
		labels = _;
		return chart;
	};

	chart.width = function (_) {
		if (!arguments.length) return width;
		width = _;
		return chart;
	};

	chart.height = function (_) {
		if (!arguments.length) return height;
		height = _;
		return chart;
	};

	chart.x = function (_) {
		if (!arguments.length) return xValue;
		xValue = _;
		return chart;
	};

	chart.y0 = function (_) {
		if (!arguments.length) return yValue0;
		yValue0 = _;
		return chart;
	};

	chart.y1 = function (_) {
		if (!arguments.length) return yValue1;
		yValue1 = _;
		return chart;
	};

	return chart;
}
